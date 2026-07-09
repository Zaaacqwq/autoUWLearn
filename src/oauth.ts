import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { createRateLimiter } from "./rateLimit.js";
import { secretsMatch } from "./secrets.js";

const scope = "learn.read";
const tokenTtlSeconds = 60 * 60 * 24 * 7;
const codeTtlMs = 10 * 60 * 1000;

// The OAuth password is the only credential guarding this resource, and every
// other authorize parameter is public (the redirect allowlist is hard-coded and
// the resource URL is published in the protected-resource metadata). Bound the
// number of guesses per window.
const authorizeLimiter = createRateLimiter({
  capacity: Number(process.env.LEARN_MCP_AUTHORIZE_ATTEMPTS ?? 10),
  windowMs: Number(process.env.LEARN_MCP_AUTHORIZE_WINDOW_MS ?? 15 * 60 * 1000)
});

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface AccessToken {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
loadTokenStore();

export function publicBaseUrl(): string {
  return (process.env.LEARN_MCP_PUBLIC_BASE_URL ?? "https://mcp.example.com").replace(/\/+$/, "");
}

export function resourceUrl(): string {
  return process.env.LEARN_MCP_RESOURCE_URL ?? `${publicBaseUrl()}/mcp`;
}

export function authorizationServerIssuer(): string {
  return process.env.LEARN_MCP_OAUTH_ISSUER ?? publicBaseUrl();
}

export function oauthChallenge(): string {
  return `Bearer resource_metadata="${publicBaseUrl()}/.well-known/oauth-protected-resource", scope="${scope}"`;
}

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [authorizationServerIssuer()],
    scopes_supported: [scope],
    bearer_methods_supported: ["header"],
    resource_name: "autoUWLearn MCP",
    resource_documentation: "https://github.com/Zaaacqwq/autoUWLearn"
  };
}

export function authorizationServerMetadata() {
  const issuer = authorizationServerIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [scope],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true
  };
}

export function registerOAuthClient(req: Request, res: Response) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const clientId =
    typeof body.client_id === "string" && body.client_id.startsWith("https://")
      ? body.client_id
      : `autouwlearn-client-${crypto.randomUUID()}`;

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope
  });
}

export function renderAuthorize(req: Request, res: Response) {
  const query = normalizeAuthorizeInput(req.query);
  const validationError = validateAuthorizeInput(query);
  if (validationError) {
    res.status(400).type("text/plain").send(validationError);
    return;
  }

  res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize autoUWLearn</title>
    <style>
      body { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 560px; margin: 64px auto; padding: 0 20px; line-height: 1.45; }
      input, button { font: inherit; width: 100%; box-sizing: border-box; padding: 12px; margin-top: 8px; }
      button { cursor: pointer; }
      .box { border: 1px solid #8885; border-radius: 12px; padding: 20px; }
      .muted { color: #777; font-size: 0.95rem; }
    </style>
  </head>
  <body>
    <h1>Authorize autoUWLearn</h1>
    <div class="box">
      <p>ChatGPT is requesting read access to your private UW LEARN MCP.</p>
      <p class="muted">This is the MCP OAuth password, not your Waterloo password.</p>
      <form method="post" action="/oauth/authorize">
        ${hidden("response_type", query.response_type)}
        ${hidden("client_id", query.client_id)}
        ${hidden("redirect_uri", query.redirect_uri)}
        ${hidden("state", query.state)}
        ${hidden("code_challenge", query.code_challenge)}
        ${hidden("code_challenge_method", query.code_challenge_method)}
        ${hidden("scope", query.scope)}
        ${hidden("resource", query.resource)}
        <label>
          OAuth password
          <input name="password" type="password" autocomplete="current-password" autofocus required />
        </label>
        <button type="submit">Authorize ChatGPT</button>
      </form>
    </div>
  </body>
</html>`);
}

export function handleAuthorize(req: Request, res: Response) {
  const input = normalizeAuthorizeInput(req.body);
  const validationError = validateAuthorizeInput(input);
  if (validationError) {
    res.status(400).type("text/plain").send(validationError);
    return;
  }

  const decision = authorizeLimiter.consume();
  if (!decision.allowed) {
    const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).type("html").send(`<!doctype html><html><body><h1>Too many attempts</h1><p>Try again in ${retryAfterSeconds} seconds.</p></body></html>`);
    return;
  }

  const expectedPassword = process.env.LEARN_MCP_OAUTH_PASSWORD ?? "";
  if (!secretsMatch(String(req.body?.password ?? ""), expectedPassword)) {
    res.status(401).type("html").send(`<!doctype html><html><body><h1>Unauthorized</h1><p>Invalid OAuth password.</p><p><a href="javascript:history.back()">Try again</a></p></body></html>`);
    return;
  }

  // A correct password clears the budget so a legitimate login is never
  // throttled by earlier failed guesses.
  authorizeLimiter.reset();
  sweepExpiredCodes();

  const code = randomToken();
  authorizationCodes.set(code, {
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    codeChallengeMethod: input.code_challenge_method,
    scope: input.scope || scope,
    resource: input.resource || resourceUrl(),
    expiresAt: Date.now() + codeTtlMs
  });

  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("code", code);
  if (input.state) redirect.searchParams.set("state", input.state);
  res.redirect(302, redirect.toString());
}

export function handleToken(req: Request, res: Response) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (body.grant_type !== "authorization_code") {
    oauthError(res, 400, "unsupported_grant_type", "Only authorization_code is supported.");
    return;
  }

  const code = String(body.code ?? "");
  const record = authorizationCodes.get(code);
  authorizationCodes.delete(code);
  if (!record || record.expiresAt < Date.now()) {
    oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
    return;
  }

  if (String(body.client_id ?? "") !== record.clientId) {
    oauthError(res, 400, "invalid_grant", "client_id does not match authorization code.");
    return;
  }
  if (String(body.redirect_uri ?? "") !== record.redirectUri) {
    oauthError(res, 400, "invalid_grant", "redirect_uri does not match authorization code.");
    return;
  }
  if (record.codeChallengeMethod !== "S256") {
    oauthError(res, 400, "invalid_grant", "Only S256 PKCE is supported.");
    return;
  }
  const verifier = String(body.code_verifier ?? "");
  if (!verifier || pkceS256(verifier) !== record.codeChallenge) {
    oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
    return;
  }

  const accessToken = randomToken();
  accessTokens.set(accessToken, {
    clientId: record.clientId,
    scope: record.scope,
    resource: record.resource,
    expiresAt: Date.now() + tokenTtlSeconds * 1000
  });
  saveTokenStore();

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: tokenTtlSeconds,
    scope: record.scope
  });
}

export function handleRevoke(req: Request, res: Response) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const token = String(body.token ?? "");
  if (token && accessTokens.delete(token)) {
    saveTokenStore();
  }

  // RFC 7009: respond 200 whether or not the token existed, so this endpoint
  // cannot be used to probe which tokens are valid.
  res.status(200).json({});
}

export function verifyAccessToken(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const record = accessTokens.get(match[1]);
  if (!record) return false;
  if (record.expiresAt < Date.now()) {
    accessTokens.delete(match[1]);
    saveTokenStore();
    return false;
  }
  return record.resource === resourceUrl() && record.scope.split(/\s+/).includes(scope);
}

function loadTokenStore() {
  try {
    const text = fs.readFileSync(config.oauthTokenStorePath, "utf8");
    const parsed = JSON.parse(text) as { accessTokens?: Array<[string, AccessToken]> };
    const now = Date.now();
    for (const [token, record] of parsed.accessTokens ?? []) {
      if (record.expiresAt > now) accessTokens.set(token, record);
    }
  } catch {
    // No persisted OAuth token store yet.
  }
}

function saveTokenStore() {
  try {
    fs.mkdirSync(path.dirname(config.oauthTokenStorePath), { recursive: true });
    const records = [...accessTokens.entries()].filter(([, record]) => record.expiresAt > Date.now());
    fs.writeFileSync(
      config.oauthTokenStorePath,
      JSON.stringify({ accessTokens: records }, null, 2),
      { mode: 0o600 }
    );
    fs.chmodSync(config.oauthTokenStorePath, 0o600);
  } catch (error) {
    console.error("Failed to persist OAuth token store:", error);
  }
}

/**
 * Authorization codes are only removed when redeemed, so codes that are issued
 * and never exchanged would accumulate for the process lifetime. Sweep them
 * whenever a new one is minted.
 */
function sweepExpiredCodes(): void {
  const now = Date.now();
  for (const [code, record] of authorizationCodes) {
    if (record.expiresAt < now) authorizationCodes.delete(code);
  }
}

function normalizeAuthorizeInput(source: unknown): Record<string, string> {
  const obj = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  return {
    response_type: first(obj.response_type),
    client_id: first(obj.client_id),
    redirect_uri: first(obj.redirect_uri),
    state: first(obj.state),
    code_challenge: first(obj.code_challenge),
    code_challenge_method: first(obj.code_challenge_method) || "plain",
    scope: first(obj.scope) || scope,
    resource: first(obj.resource) || resourceUrl()
  };
}

function validateAuthorizeInput(input: Record<string, string>): string | undefined {
  if (input.response_type !== "code") return "response_type must be code.";
  if (!input.client_id) return "client_id is required.";
  if (!input.redirect_uri) return "redirect_uri is required.";
  if (!isAllowedRedirectUri(input.redirect_uri)) return "redirect_uri is not allowed.";
  if (!input.code_challenge) return "code_challenge is required.";
  if (input.code_challenge_method !== "S256") return "code_challenge_method must be S256.";
  if (input.resource !== resourceUrl()) return `resource must be ${resourceUrl()}.`;
  return undefined;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && (
      url.pathname.startsWith("/connector/oauth/") ||
      url.pathname === "/connector_platform_oauth_redirect"
    );
  } catch {
    return false;
  }
}

function first(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  if (value == null) return "";
  return String(value);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({
    error,
    error_description: description
  });
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
