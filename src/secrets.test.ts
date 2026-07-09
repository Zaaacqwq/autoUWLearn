import assert from "node:assert/strict";
import test from "node:test";
import { secretsMatch } from "./secrets.js";

test("matching secrets compare equal", () => {
  assert.equal(secretsMatch("correct-horse-battery-staple", "correct-horse-battery-staple"), true);
});

test("differing secrets compare unequal", () => {
  assert.equal(secretsMatch("wrong", "correct-horse-battery-staple"), false);
});

test("fails closed when the expected secret is unset", () => {
  assert.equal(secretsMatch("anything", ""), false);
  assert.equal(secretsMatch("", ""), false);
  assert.equal(secretsMatch("", "configured"), false);
});

test("secrets of differing lengths do not throw", () => {
  // crypto.timingSafeEqual throws on length mismatch, so the implementation
  // must equalise length (by hashing) before comparing.
  assert.doesNotThrow(() => secretsMatch("a", "a-much-longer-configured-secret"));
  assert.equal(secretsMatch("a", "a-much-longer-configured-secret"), false);
});

test("a supplied secret that is a prefix of the expected one does not match", () => {
  assert.equal(secretsMatch("secret", "secret-plus-more"), false);
});

test("comparison is byte-exact, not normalised", () => {
  assert.equal(secretsMatch("Secret", "secret"), false);
  assert.equal(secretsMatch(" secret", "secret"), false);
});

test("handles unicode without throwing", () => {
  assert.equal(secretsMatch("密码🔑", "密码🔑"), true);
  assert.equal(secretsMatch("密码🔑", "密码"), false);
});
