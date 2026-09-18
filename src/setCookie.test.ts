import assert from "node:assert/strict";
import test from "node:test";
import { isCookieCleared, parseSetCookie, parseSetCookies } from "./setCookie.js";

const HOST = "learn.uwaterloo.ca";

test("reads the name and value, and scopes to the answering host by default", () => {
  const cookie = parseSetCookie("d2lSessionVal=abc123; path=/; HttpOnly; Secure", HOST);
  assert.equal(cookie?.name, "d2lSessionVal");
  assert.equal(cookie?.value, "abc123");
  assert.equal(cookie?.domain, HOST);
  assert.equal(cookie?.path, "/");
  assert.equal(cookie?.httpOnly, true);
  assert.equal(cookie?.secure, true);
});

test("a session cookie with no expiry is marked -1, as the storage state stores it", () => {
  assert.equal(parseSetCookie("d2lSessionVal=abc", HOST)?.expires, -1);
});

test("an explicit Domain is normalised to the leading-dot form", () => {
  assert.equal(parseSetCookie("a=b; Domain=uwaterloo.ca", HOST)?.domain, ".uwaterloo.ca");
  assert.equal(parseSetCookie("a=b; Domain=.uwaterloo.ca", HOST)?.domain, ".uwaterloo.ca");
});

test("Max-Age wins over Expires, per RFC 6265", () => {
  const cookie = parseSetCookie("a=b; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=60", HOST);
  const expected = Math.floor(Date.now() / 1000) + 60;
  assert.ok(Math.abs((cookie?.expires ?? 0) - expected) <= 2);
});

test("a value containing '=' survives intact", () => {
  assert.equal(parseSetCookie("d2lSecureSessionVal=aGk=; path=/", HOST)?.value, "aGk=");
});

test("SameSite is normalised to the casing Playwright expects", () => {
  assert.equal(parseSetCookie("a=b; SameSite=none", HOST)?.sameSite, "None");
  assert.equal(parseSetCookie("a=b; SameSite=STRICT", HOST)?.sameSite, "Strict");
});

test("headers that are not cookies are dropped rather than throwing", () => {
  assert.equal(parseSetCookie("", HOST), null);
  assert.equal(parseSetCookie("=novalue", HOST), null);
  assert.deepEqual(parseSetCookies(["", "a=b"], HOST).map((cookie) => cookie.name), ["a"]);
});

test("an empty value is a deletion", () => {
  const cookie = parseSetCookie("d2lSessionVal=; path=/", HOST);
  assert.ok(cookie);
  assert.equal(isCookieCleared(cookie), true);
});

test("an expiry in the past is a deletion", () => {
  const cookie = parseSetCookie("d2lSessionVal=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT", HOST);
  assert.ok(cookie);
  assert.equal(isCookieCleared(cookie), true);
});

test("a live cookie is not a deletion", () => {
  const cookie = parseSetCookie("d2lSessionVal=x; Max-Age=3600", HOST);
  assert.ok(cookie);
  assert.equal(isCookieCleared(cookie), false);
});
