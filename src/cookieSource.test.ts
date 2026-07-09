import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cookieHeaderFromStorageState, MissingSessionCookiesError } from "./cookieSource.js";

function writeState(cookies: Array<{ name: string; value: string; domain: string }>): string {
  const file = path.join(os.tmpdir(), `autouwlearn-state-${process.pid}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({ cookies, origins: [] }));
  return file;
}

const sessionCookies = [
  { name: "d2lSessionVal", value: "aaa", domain: "learn.uwaterloo.ca" },
  { name: "d2lSecureSessionVal", value: "bbb", domain: "learn.uwaterloo.ca" }
];

test("builds a cookie header from the LEARN cookies", () => {
  const file = writeState(sessionCookies);
  const header = cookieHeaderFromStorageState(file, "learn.uwaterloo.ca");
  assert.match(header, /d2lSessionVal=aaa/);
  assert.match(header, /d2lSecureSessionVal=bbb/);
});

test("ignores cookies belonging to other domains", () => {
  const file = writeState([
    ...sessionCookies,
    { name: "duoSession", value: "ccc", domain: "uwaterloo.login.duosecurity.com" },
    { name: "adfsAuth", value: "ddd", domain: "adfs.uwaterloo.ca" }
  ]);
  const header = cookieHeaderFromStorageState(file, "learn.uwaterloo.ca");
  assert.doesNotMatch(header, /duoSession/);
  assert.doesNotMatch(header, /adfsAuth/);
});

test("matches cookies on a dot-prefixed parent domain", () => {
  const file = writeState([...sessionCookies, { name: "shared", value: "eee", domain: ".uwaterloo.ca" }]);
  const header = cookieHeaderFromStorageState(file, "learn.uwaterloo.ca");
  assert.match(header, /shared=eee/);
});

test("both session cookies are required: either one alone is rejected", () => {
  // LEARN answers 403 when only one of the pair is presented, so failing here
  // produces a clearer error than a confusing 403 later.
  for (const only of sessionCookies) {
    const file = writeState([only]);
    assert.throws(() => cookieHeaderFromStorageState(file, "learn.uwaterloo.ca"), MissingSessionCookiesError);
  }
});

test("a missing or unreadable storage state is reported as missing cookies", () => {
  assert.throws(
    () => cookieHeaderFromStorageState("/nonexistent/storage-state.json", "learn.uwaterloo.ca"),
    MissingSessionCookiesError
  );
});

test("the error names the cookies that were absent", () => {
  const file = writeState([sessionCookies[0]]);
  try {
    cookieHeaderFromStorageState(file, "learn.uwaterloo.ca");
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof MissingSessionCookiesError);
    assert.deepEqual(error.missing, ["d2lSecureSessionVal"]);
  }
});
