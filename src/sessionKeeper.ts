import { LearnAuthError } from "./learnApi.js";
import { MissingSessionCookiesError } from "./cookieSource.js";

/** Five minutes sits comfortably under any plausible Brightspace idle timeout. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export type SessionState = "unknown" | "alive" | "degraded" | "expired";

export interface SessionStatus {
  readonly state: SessionState;
  readonly lastOkAt: number | null;
  readonly lastErrorAt: number | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface SessionKeeperOptions {
  /** Throws LearnAuthError when the session is gone. Cheapest probe is whoami. */
  readonly probe: () => Promise<void>;
  /** Attempt a silent re-login. Resolves true when the session is usable again. */
  readonly recover?: () => Promise<boolean>;
  /** Called once per outage, when only a human can fix it. */
  readonly onExpired?: (error: Error) => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Opaque so tests can substitute a hand-advanced clock. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export type TimerHandle = unknown;

export interface SessionKeeper {
  start(): void;
  stop(): void;
  ping(): Promise<void>;
  status(): SessionStatus;
}

const isSessionGone = (error: unknown): boolean =>
  error instanceof LearnAuthError || error instanceof MissingSessionCookiesError;

/**
 * Keeps the LEARN session warm.
 *
 * Brightspace expires a session that sees no activity ("Your session was open
 * without any activity for a while"), and there is no dedicated keep-alive
 * endpoint — any authenticated request counts. So we make one on a timer.
 *
 * If the session dies anyway, that tells us the timeout is absolute rather than
 * idle, and the recovery path takes over: a silent re-login through the browser
 * profile, which succeeds while the upstream SSO session is still valid. Only
 * when that fails does a human need to type a password.
 */
export function createSessionKeeper(options: SessionKeeperOptions): SessionKeeper {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as never));

  let handle: TimerHandle;
  let running = false;
  let state: SessionState = "unknown";
  let lastOkAt: number | null = null;
  let lastErrorAt: number | null = null;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  // Latches so one outage produces one notification, not one per probe.
  let notified = false;

  const schedule = (): void => {
    if (!running) return;
    handle = setTimer(() => {
      void ping().finally(schedule);
    }, intervalMs);
  };

  const markAlive = (): void => {
    state = "alive";
    lastOkAt = now();
    consecutiveFailures = 0;
    lastError = null;
    notified = false;
  };

  async function ping(): Promise<void> {
    try {
      await options.probe();
      markAlive();
      return;
    } catch (error) {
      lastErrorAt = now();
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : String(error);

      if (!isSessionGone(error)) {
        // A dropped packet is not a reason to send the user to a login page.
        state = "degraded";
        return;
      }

      if (options.recover && (await options.recover().catch(() => false))) {
        markAlive();
        return;
      }

      state = "expired";
      if (!notified) {
        notified = true;
        options.onExpired?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      schedule();
    },

    stop(): void {
      running = false;
      if (handle) clearTimer(handle);
      handle = undefined;
    },

    ping,

    status: (): SessionStatus => ({ state, lastOkAt, lastErrorAt, consecutiveFailures, lastError })
  };
}
