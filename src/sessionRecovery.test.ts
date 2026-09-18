import assert from "node:assert/strict";
import test from "node:test";
import { MissingSessionCookiesError } from "./cookieSource.js";
import { LearnAuthError, LearnHttpError, LearnPermissionError } from "./learnApi.js";
import { createSessionRecovery } from "./sessionRecovery.js";

const authError = () => new LearnAuthError("/d2l/api/lp/1.61/users/whoami");

test("a read that works is passed straight through", async () => {
  let recoveries = 0;
  const recovery = createSessionRecovery({
    recover: async () => {
      recoveries += 1;
      return true;
    }
  });

  assert.equal(await recovery.run(async () => "courses"), "courses");
  assert.equal(recoveries, 0);
});

test("a lapsed session is repaired underneath the read, which then succeeds", async () => {
  let attempts = 0;
  const recovery = createSessionRecovery({ recover: async () => true });

  const result = await recovery.run(async () => {
    attempts += 1;
    if (attempts === 1) throw authError();
    return "courses";
  });

  assert.equal(result, "courses");
  assert.equal(attempts, 2);
});

test("absent cookies are repaired too, not only a rejected session", async () => {
  let attempts = 0;
  const recovery = createSessionRecovery({ recover: async () => true });

  await recovery.run(async () => {
    attempts += 1;
    if (attempts === 1) throw new MissingSessionCookiesError(["d2lSessionVal"]);
    return "ok";
  });

  assert.equal(attempts, 2);
});

test("when only a human can log in, the original error reaches the caller", async () => {
  const recovery = createSessionRecovery({ recover: async () => false });

  await assert.rejects(
    () =>
      recovery.run(async () => {
        throw authError();
      }),
    LearnAuthError
  );
});

test("a recovery that throws is a failed recovery, not a new error", async () => {
  const recovery = createSessionRecovery({
    recover: async () => {
      throw new Error("chromium failed to launch");
    }
  });

  await assert.rejects(
    () =>
      recovery.run(async () => {
        throw authError();
      }),
    LearnAuthError
  );
});

test("errors that are not about the session never start a browser", async () => {
  let recoveries = 0;
  const recovery = createSessionRecovery({
    recover: async () => {
      recoveries += 1;
      return true;
    }
  });

  // An org unit the user cannot see is a 403 too, and re-logging in cannot help.
  await assert.rejects(
    () => recovery.run(async () => Promise.reject(new LearnPermissionError("/labs"))),
    LearnPermissionError
  );
  await assert.rejects(
    () => recovery.run(async () => Promise.reject(new LearnHttpError(500, "/grades"))),
    LearnHttpError
  );
  assert.equal(recoveries, 0);
});

test("it retries once, not until it gives up", async () => {
  let attempts = 0;
  const recovery = createSessionRecovery({ recover: async () => true });

  await assert.rejects(
    () =>
      recovery.run(async () => {
        attempts += 1;
        throw authError();
      }),
    LearnAuthError
  );
  assert.equal(attempts, 2);
});

test("concurrent reads share one re-login rather than starting a browser each", async () => {
  let recoveries = 0;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });

  const recovery = createSessionRecovery({
    recover: async () => {
      recoveries += 1;
      await started;
      return true;
    }
  });

  const read = () => {
    let first = true;
    return recovery.run(async () => {
      if (first) {
        first = false;
        throw authError();
      }
      return "ok";
    });
  };

  const all = Promise.all([read(), read(), read()]);
  release();

  assert.deepEqual(await all, ["ok", "ok", "ok"]);
  assert.equal(recoveries, 1);
});

test("after a failed re-login it backs off instead of relaunching a browser per call", async () => {
  let recoveries = 0;
  let now = 0;
  const recovery = createSessionRecovery({
    recover: async () => {
      recoveries += 1;
      return false;
    },
    backoffMs: 1000,
    now: () => now
  });

  const failing = () =>
    assert.rejects(
      () =>
        recovery.run(async () => {
          throw authError();
        }),
      LearnAuthError
    );

  await failing();
  now = 500;
  await failing();
  assert.equal(recoveries, 1, "still inside the backoff window");

  now = 1500;
  await failing();
  assert.equal(recoveries, 2, "the window has passed, so try again");
});

test("a success does not arm the backoff, so the next lapse recovers at once", async () => {
  let recoveries = 0;
  const now = 0;
  const recovery = createSessionRecovery({
    recover: async () => {
      recoveries += 1;
      return true;
    },
    backoffMs: 1000,
    now: () => now
  });

  // One lapse, repaired.
  const readOnce = async () => {
    let failed = false;
    return recovery.run(async () => {
      if (!failed) {
        failed = true;
        throw authError();
      }
      return "ok";
    });
  };

  assert.equal(await readOnce(), "ok");
  // A second lapse on the same frozen clock: nothing is blocking recovery,
  // which a failed attempt would have done for backoffMs.
  assert.equal(await readOnce(), "ok");
  assert.equal(recoveries, 2);
});
