import { MissingSessionCookiesError } from "./cookieSource.js";
import { LearnAuthError } from "./learnApi.js";

export interface SessionRecoveryOptions {
  /**
   * Attempts a silent re-login. Resolves true when the session is usable again.
   * Expensive — it drives a browser — so this module calls it sparingly.
   */
  readonly recover: () => Promise<boolean>;
  /** How long to stop retrying after a recovery that failed. */
  readonly backoffMs?: number;
  readonly now?: () => number;
}

export interface SessionRecovery {
  /** Runs a read, repairing a lapsed session underneath it where possible. */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Five minutes: long enough that a dead SSO does not relaunch a browser per call. */
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;

export const isSessionGone = (error: unknown): boolean =>
  error instanceof LearnAuthError || error instanceof MissingSessionCookiesError;

/**
 * Repairs a lapsed LEARN session in the middle of a read.
 *
 * The heartbeat already re-logs in silently, but only on its own timer, so a
 * question asked in the window between the session lapsing and the next beat
 * was answered with "your login expired" even though nothing needed the user:
 * Waterloo's upstream SSO outlives the Brightspace session and Duo remembers
 * the device, so replaying the handshake usually just works. Doing it here, on
 * the failing call, is the difference between the user noticing and not.
 *
 * One retry only. If a read fails twice around a recovery that claimed success,
 * the session is not the problem and looping would only delay the real error.
 */
export function createSessionRecovery(options: SessionRecoveryOptions): SessionRecovery {
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const now = options.now ?? Date.now;

  // Concurrent tool calls fail together; they must share one re-login, not
  // start a browser each.
  let inFlight: Promise<boolean> | undefined;
  let blockedUntil = 0;

  const recoverOnce = async (): Promise<boolean> => {
    if (now() < blockedUntil) return false;

    inFlight ??= options
      .recover()
      .catch(() => false)
      .finally(() => {
        inFlight = undefined;
      });

    const recovered = await inFlight;
    if (!recovered) blockedUntil = now() + backoffMs;
    return recovered;
  };

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        if (!isSessionGone(error)) throw error;
        if (!(await recoverOnce())) throw error;
        return operation();
      }
    }
  };
}
