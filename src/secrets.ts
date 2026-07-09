import crypto from "node:crypto";

/**
 * Compares a supplied secret against the configured one without leaking the
 * expected value through comparison timing.
 *
 * Both sides are hashed first so that `timingSafeEqual` always receives equal
 * length buffers; it throws otherwise, and the length of the thrown-vs-returned
 * path would itself disclose the secret's length.
 *
 * Returns false when no secret is configured, so callers fail closed.
 */
export function secretsMatch(supplied: string, expected: string): boolean {
  if (expected.length === 0) return false;

  const suppliedDigest = crypto.createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();

  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}
