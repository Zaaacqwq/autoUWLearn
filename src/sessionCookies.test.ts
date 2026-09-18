import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MissingSessionCookiesError, type SessionCookie } from "./cookieSource.js";
import { createCookieHeaderProvider, createSessionCookieStore } from "./sessionCookies.js";

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

/* Absorbing rotated cookies: the write-back half that keeps the header usable. */

function readJar(file: string): SessionCookie[] {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { cookies: SessionCookie[] }).cookies;
}

function store(file: string) {
  return createSessionCookieStore({ liveCookies: async () => null, storageStatePath: file, host: HOST });
}

test("a rotated session cookie is written over the stale one on disk", async () => {
  const file = stateFile(cookies("stale"));
  const jar = store(file);

  const written = jar.absorb(["d2lSessionVal=rotated; path=/; HttpOnly"]);

  assert.deepEqual(written, ["d2lSessionVal"]);
  assert.match(await jar.header(), /d2lSessionVal=rotated/);
  assert.match(await jar.header(), /d2lSecureSessionVal=stale/);
});

test("the rotation survives into the next process, not just this one", () => {
  const file = stateFile(cookies("stale"));
  store(file).absorb(["d2lSessionVal=rotated; path=/"]);

  const value = readJar(file).find((cookie) => cookie.name === "d2lSessionVal")?.value;
  assert.equal(value, "rotated");
});

test("everything else in the storage state is preserved", () => {
  const file = path.join(os.tmpdir(), `autouwlearn-origins-${process.pid}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({ cookies: cookies("stale"), origins: [{ origin: "https://x" }] }));

  store(file).absorb(["d2lSessionVal=rotated; path=/"]);

  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { origins: unknown[]; cookies: SessionCookie[] };
  assert.deepEqual(state.origins, [{ origin: "https://x" }]);
  assert.equal(state.cookies.length, 2);
});

test("a response that rotated nothing does not rewrite the file", () => {
  const file = stateFile(cookies("same"));
  const before = fs.statSync(file).mtimeMs;

  assert.deepEqual(store(file).absorb(["d2lSessionVal=same; path=/"]), []);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("cookies LEARN sets that are not the session are ignored", () => {
  const file = stateFile(cookies("stale"));

  assert.deepEqual(store(file).absorb(["d2l_analytics=1; path=/", "ASP.NET_SessionId=zz"]), []);
  assert.equal(readJar(file).length, 2);
});

test("a logout is never absorbed over a live session", async () => {
  // LEARN clears the cookie on its own sign-out page. Persisting that would log
  // the server out for good, and only a human could undo it.
  const file = stateFile(cookies("live"));
  const jar = store(file);

  assert.deepEqual(jar.absorb(["d2lSessionVal=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]), []);
  assert.match(await jar.header(), /d2lSessionVal=live/);
});

test("with no snapshot on disk there is nothing to update", () => {
  const file = path.join(os.tmpdir(), `autouwlearn-absent-${process.pid}-${Math.random()}.json`);

  assert.deepEqual(store(file).absorb(["d2lSessionVal=rotated"]), []);
  assert.equal(fs.existsSync(file), false);
});
