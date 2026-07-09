import assert from "node:assert/strict";
import test from "node:test";
import { LearnAuthError, LearnNetworkError } from "./learnApi.js";
import { createSessionKeeper } from "./sessionKeeper.js";

/** A timer we advance by hand, so no test waits on a real clock. */
function fakeTimers() {
  let now = 0;
  const scheduled: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;

  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ at: now + ms, fn, id });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (handle: NodeJS.Timeout) => {
      const index = scheduled.findIndex((t) => t.id === (handle as unknown as number));
      if (index >= 0) scheduled.splice(index, 1);
    },
    /** Fire every timer due at or before `now + ms`, then let promises settle. */
    async advance(ms: number) {
      now += ms;
      const due = scheduled.filter((t) => t.at <= now);
      for (const t of due) {
        scheduled.splice(scheduled.indexOf(t), 1);
        t.fn();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      }
    },
    pending: () => scheduled.length
  };
}

const authError = () => new LearnAuthError("/d2l/api/lp/1.61/users/whoami");

function build(overrides: Record<string, unknown> = {}) {
  const timers = fakeTimers();
  const calls = { probes: 0, recoveries: 0, expired: [] as Error[] };

  const keeper = createSessionKeeper({
    intervalMs: 300_000,
    probe: async () => {
      calls.probes += 1;
    },
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides
  } as never);

  return { keeper, timers, calls };
}

test("probes on the interval while the session is alive", async () => {
  const { keeper, timers, calls } = build();
  keeper.start();

  await timers.advance(300_000);
  await timers.advance(300_000);

  assert.equal(calls.probes, 2);
  assert.equal(keeper.status().state, "alive");
});

test("records when the session was last confirmed alive", async () => {
  const { keeper, timers } = build();
  keeper.start();
  await timers.advance(300_000);

  assert.equal(keeper.status().lastOkAt, 300_000);
});

test("stop cancels the schedule", async () => {
  const { keeper, timers, calls } = build();
  keeper.start();
  keeper.stop();

  await timers.advance(900_000);
  assert.equal(calls.probes, 0);
  assert.equal(timers.pending(), 0);
});

test("an expired session triggers a silent recovery, and stays alive when it works", async () => {
  let probes = 0;
  let recoveries = 0;
  const { keeper, timers } = build({
    probe: async () => {
      probes += 1;
      if (probes === 1) throw authError();
    },
    recover: async () => {
      recoveries += 1;
      return true;
    }
  });

  keeper.start();
  await timers.advance(300_000);

  assert.equal(recoveries, 1);
  assert.equal(keeper.status().state, "alive");
});

test("when recovery fails the session is expired and the human is told once", async () => {
  const expired: Error[] = [];
  const { keeper, timers } = build({
    probe: async () => {
      throw authError();
    },
    recover: async () => false,
    onExpired: (error: Error) => expired.push(error)
  });

  keeper.start();
  await timers.advance(300_000);
  assert.equal(keeper.status().state, "expired");
  assert.equal(expired.length, 1);

  // Still expired on the next tick, but do not nag.
  await timers.advance(300_000);
  assert.equal(expired.length, 1, "the human is notified once per outage, not once per probe");
});

test("a session that comes back to life re-arms the notification", async () => {
  let alive = false;
  const expired: Error[] = [];
  const { keeper, timers } = build({
    probe: async () => {
      if (!alive) throw authError();
    },
    recover: async () => false,
    onExpired: (error: Error) => expired.push(error)
  });

  keeper.start();
  await timers.advance(300_000);
  assert.equal(expired.length, 1);

  alive = true; // the user logged in by hand
  await timers.advance(300_000);
  assert.equal(keeper.status().state, "alive");

  alive = false;
  await timers.advance(300_000);
  assert.equal(expired.length, 2, "a new outage warrants a new notification");
});

test("a transient network failure is not mistaken for an expired session", async () => {
  const expired: Error[] = [];
  const { keeper, timers } = build({
    probe: async () => {
      throw new LearnNetworkError("/whoami", new Error("ECONNRESET"));
    },
    recover: async () => false,
    onExpired: (error: Error) => expired.push(error)
  });

  keeper.start();
  await timers.advance(300_000);

  assert.equal(keeper.status().state, "degraded", "the network is down, not the session");
  assert.equal(expired.length, 0, "do not send the user to log in over a dropped packet");
  assert.equal(keeper.status().consecutiveFailures, 1);
});

test("keeps probing after a network failure and recovers silently", async () => {
  let fail = true;
  const { keeper, timers } = build({
    probe: async () => {
      if (fail) throw new LearnNetworkError("/whoami", new Error("ECONNRESET"));
    }
  });

  keeper.start();
  await timers.advance(300_000);
  assert.equal(keeper.status().state, "degraded");

  fail = false;
  await timers.advance(300_000);
  assert.equal(keeper.status().state, "alive");
  assert.equal(keeper.status().consecutiveFailures, 0);
});

test("ping probes immediately without waiting for the interval", async () => {
  const { keeper, calls } = build();
  await keeper.ping();
  assert.equal(calls.probes, 1);
  assert.equal(keeper.status().state, "alive");
});
