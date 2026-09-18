import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSession, type BrowserSessionDeps } from "./browserSession.js";

/**
 * A session whose browser cannot be started.
 *
 * Answering "am I logged in?" used to launch Chromium and walk into Waterloo's
 * SSO, which does not fit in a tool deadline — the question about the session
 * timed out and told the user nothing about the session. Anything that reaches
 * for a browser here fails loudly instead.
 */
class NoBrowser extends BrowserSession {
  constructor(deps: BrowserSessionDeps) {
    super(deps);
  }

  override async ensureContext(): Promise<never> {
    throw new Error("a session check must not start a browser");
  }
}

test("a working session is reported without starting a browser", async () => {
  const status = await new NoBrowser({ sessionWorks: async () => true }).sessionStatus();

  assert.equal(status.authenticated, true);
  assert.equal(status.state, "LOGGED_IN");
});

test("a session that does not work is reported without starting one either", async () => {
  const status = await new NoBrowser({ sessionWorks: async () => false }).sessionStatus();

  assert.equal(status.authenticated, false);
  assert.match(status.authUrl, /\/auth$/);
  // With no browser open there is nothing to explain the failure with, so the
  // state says only that a login is needed.
  assert.ok(["NOT_LOGGED_IN", "SESSION_EXPIRED"].includes(status.state), status.state);
});

test("the cookies handed to the probe are the saved ones, not a browser's", async () => {
  let seen: unknown;
  await new NoBrowser({
    sessionWorks: async (cookies) => {
      seen = cookies;
      return false;
    }
  }).sessionStatus();

  assert.ok(Array.isArray(seen), "the probe is always given a jar, even an empty one");
});
