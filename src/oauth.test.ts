import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Request, Response } from "express";

const password = "test-oauth-password";
const capacity = 3;

process.env.LEARN_MCP_OAUTH_PASSWORD = password;
process.env.LEARN_MCP_AUTHORIZE_ATTEMPTS = String(capacity);
process.env.LEARN_MCP_AUTHORIZE_WINDOW_MS = String(15 * 60 * 1000);
process.env.LEARN_MCP_PUBLIC_BASE_URL = "https://mcp.example.test";
process.env.LEARN_MCP_RESOURCE_URL = "https://mcp.example.test/mcp";
process.env.LEARN_OAUTH_TOKEN_STORE_PATH = path.join(
  os.tmpdir(),
  `autouwlearn-oauth-test-${process.pid}.json`
);

// Imported after the environment is set: oauth.js builds its rate limiter and
// loads its token store at module scope.
const { handleAuthorize, handleRevoke } = await import("./oauth.js");

interface CapturedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  redirectedTo?: string;
}

function fakeRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: "", headers: {} };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(payload: string) {
      captured.body = payload;
      return this;
    },
    json(payload: unknown) {
      captured.body = JSON.stringify(payload);
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    redirect(code: number, url: string) {
      captured.statusCode = code;
      captured.redirectedTo = url;
      return this;
    }
  } as unknown as Response;
  return { res, captured };
}

function authorizeBody(overrides: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: "https://chatgpt.com/connector",
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    state: "opaque-state",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "learn.read",
    resource: "https://mcp.example.test/mcp",
    ...overrides
  };
}

function authorize(body: Record<string, string>): CapturedResponse {
  const { res, captured } = fakeRes();
  handleAuthorize({ body } as unknown as Request, res);
  return captured;
}

test("a correct password redirects back with an authorization code", () => {
  const result = authorize(authorizeBody({ password }));

  assert.equal(result.statusCode, 302);
  assert.ok(result.redirectedTo, "expected a redirect");

  const redirect = new URL(result.redirectedTo as string);
  assert.equal(redirect.origin + redirect.pathname, "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.ok(redirect.searchParams.get("code"), "expected an authorization code");
  assert.equal(redirect.searchParams.get("state"), "opaque-state");
});

test("a wrong password is rejected, and repeated guesses are rate limited", () => {
  // The previous test succeeded, which resets the bucket to full capacity.
  for (let attempt = 1; attempt <= capacity; attempt += 1) {
    const rejected = authorize(authorizeBody({ password: `guess-${attempt}` }));
    assert.equal(rejected.statusCode, 401, `attempt ${attempt} should be unauthorized, not throttled`);
  }

  const throttled = authorize(authorizeBody({ password: "guess-4" }));
  assert.equal(throttled.statusCode, 429);
  assert.ok(Number(throttled.headers["retry-after"]) > 0, "expected a positive Retry-After");
});

test("an exhausted budget throttles even the correct password until it refills", () => {
  // Documents the deliberate tradeoff of a global limiter: an attacker can lock
  // the owner out for at most one window, which beats unbounded guessing.
  const throttled = authorize(authorizeBody({ password }));
  assert.equal(throttled.statusCode, 429);
});

test("malformed requests are rejected before they consume rate limit budget", () => {
  const bad = authorize(authorizeBody({ password, response_type: "token" }));
  assert.equal(bad.statusCode, 400);

  const wrongResource = authorize(authorizeBody({ password, resource: "https://evil.example/mcp" }));
  assert.equal(wrongResource.statusCode, 400);

  const badRedirect = authorize(authorizeBody({ password, redirect_uri: "https://evil.example/cb" }));
  assert.equal(badRedirect.statusCode, 400);
});

test("revoking an unknown token still answers 200 so tokens cannot be probed", () => {
  const { res, captured } = fakeRes();
  handleRevoke({ body: { token: "not-a-real-token" } } as unknown as Request, res);
  assert.equal(captured.statusCode, 200);

  const { res: res2, captured: captured2 } = fakeRes();
  handleRevoke({ body: {} } as unknown as Request, res2);
  assert.equal(captured2.statusCode, 200);
});
