import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MissingSessionCookiesError, type SessionCookie } from "./cookieSource.js";
import { createCookieHeaderProvider } from "./sessionCookies.js";

const HOST = "learn.uwaterloo.ca";

const cookies = (value: string): SessionCookie[] => [
  { name: "d2lSessionVal", value, domain: HOST },
  { name: "d2lSecureSessionVal", value, domain: HOST }
];

function stateFile(jar: SessionCookie[]): string {
  const file = path.join(os.tmpdir(), `autouwlearn-sess-${process.pid}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({ cookies: jar, origins: [] }));
  return file;
}

test("prefers the live browser cookies over the snapshot on disk", async () => {
  const provider = createCookieHeaderProvider({
    liveCookies: async () => cookies("fresh"),
    storageStatePath: stateFile(cookies("stale")),
    host: HOST
  });

  const header = await provider();
  assert.match(header, /fresh/);
  assert.doesNotMatch(header, /stale/);
});

test("falls back to the snapshot when no browser context is open", async () => {
  const provider = createCookieHeaderProvider({
    liveCookies: async () => null,
    storageStatePath: stateFile(cookies("stale")),
    host: HOST
  });

  assert.match(await provider(), /stale/);
});

test("falls back when the live context has no LEARN session cookies yet", async () => {
  // A freshly launched browser has a context but has not completed SSO.
  const provider = createCookieHeaderProvider({
    liveCookies: async () => [{ name: "someOtherCookie", value: "x", domain: HOST }],
    storageStatePath: stateFile(cookies("stale")),
    host: HOST
  });

  assert.match(await provider(), /stale/);
});

test("falls back when reading the live context throws", async () => {
  const provider = createCookieHeaderProvider({
    liveCookies: async () => {
      throw new Error("browser closed");
    },
    storageStatePath: stateFile(cookies("stale")),
    host: HOST
  });

  assert.match(await provider(), /stale/);
});

test("surfaces MissingSessionCookiesError when neither source has a session", async () => {
  const provider = createCookieHeaderProvider({
    liveCookies: async () => null,
    storageStatePath: stateFile([]),
    host: HOST
  });

  await assert.rejects(() => provider(), MissingSessionCookiesError);
});
