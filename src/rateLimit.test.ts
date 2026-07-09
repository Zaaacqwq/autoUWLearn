import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "./rateLimit.js";

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

test("allows exactly capacity attempts, then denies", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 3, windowMs: 60_000, now: clock.now });

  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);

  const last = limiter.consume();
  assert.equal(last.allowed, true);
  assert.equal(last.remaining, 0);

  assert.equal(limiter.consume().allowed, false);
});

test("a denied attempt reports how long to wait and does not go negative", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 2, windowMs: 60_000, now: clock.now });

  limiter.consume();
  limiter.consume();

  const denied = limiter.consume();
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0, "retryAfterMs should be positive when denied");
  assert.ok(denied.retryAfterMs <= 60_000, "retryAfterMs should never exceed the window");
});

test("denied attempts do not deepen the hole (no token debt)", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 1, windowMs: 1_000, now: clock.now });

  limiter.consume();
  for (let i = 0; i < 50; i += 1) limiter.consume();

  // One full window later a single token is available regardless of how many
  // attempts were rejected in between.
  clock.advance(1_000);
  assert.equal(limiter.consume().allowed, true);
});

test("tokens refill gradually across the window", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 4, windowMs: 4_000, now: clock.now });

  for (let i = 0; i < 4; i += 1) assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, false);

  // 1 token per 1000ms.
  clock.advance(999);
  assert.equal(limiter.consume().allowed, false);

  clock.advance(1);
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, false);
});

test("refill is capped at capacity", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 2, windowMs: 1_000, now: clock.now });

  clock.advance(10_000_000);

  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, false);
});

test("reset restores full capacity (used after a successful login)", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ capacity: 2, windowMs: 60_000, now: clock.now });

  limiter.consume();
  limiter.consume();
  assert.equal(limiter.consume().allowed, false);

  limiter.reset();

  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, false);
});

test("capacity must be a positive integer", () => {
  assert.throws(() => createRateLimiter({ capacity: 0, windowMs: 1_000 }), /capacity/);
  assert.throws(() => createRateLimiter({ capacity: -1, windowMs: 1_000 }), /capacity/);
  assert.throws(() => createRateLimiter({ capacity: 1, windowMs: 0 }), /windowMs/);
});
