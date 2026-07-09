export interface RateLimiterOptions {
  /** Attempts permitted per window. */
  readonly capacity: number;
  /** Time for an exhausted bucket to refill completely, in milliseconds. */
  readonly windowMs: number;
  /** Injectable clock; defaults to Date.now. */
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Milliseconds until the next attempt is permitted. Zero when allowed. */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  consume(): RateLimitDecision;
  reset(): void;
}

/**
 * A token bucket that refills continuously.
 *
 * This limiter is deliberately *global* rather than keyed by client IP. Behind
 * a Cloudflare tunnel every request arrives from a Cloudflare edge address, so
 * per-IP buckets would either collapse into one bucket anyway or, if keyed on
 * the client-controlled `CF-Connecting-IP` header, be trivially bypassed by
 * rotating that header. A single-user server loses nothing by limiting globally
 * and gains an attacker-independent bound on guesses per window.
 *
 * Budget is tracked as earned milliseconds instead of fractional tokens, which
 * keeps refill arithmetic exact and free of floating point drift.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, windowMs } = options;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`rateLimit: capacity must be a positive integer, received ${capacity}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`rateLimit: windowMs must be greater than zero, received ${windowMs}`);
  }

  const now = options.now ?? Date.now;
  const msPerToken = windowMs / capacity;

  let availableMs = windowMs;
  let lastRefillAt = now();

  const refill = (): void => {
    const timestamp = now();
    const elapsed = timestamp - lastRefillAt;
    lastRefillAt = timestamp;
    if (elapsed <= 0) return;
    availableMs = Math.min(windowMs, availableMs + elapsed);
  };

  return {
    consume(): RateLimitDecision {
      refill();

      if (availableMs < msPerToken) {
        // A rejected attempt must not consume budget, otherwise a flood of
        // guesses would push the legitimate user ever further from retrying.
        return Object.freeze({
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.ceil(msPerToken - availableMs)
        });
      }

      availableMs -= msPerToken;
      return Object.freeze({
        allowed: true,
        remaining: Math.floor(availableMs / msPerToken),
        retryAfterMs: 0
      });
    },

    reset(): void {
      availableMs = windowMs;
      lastRefillAt = now();
    }
  };
}
