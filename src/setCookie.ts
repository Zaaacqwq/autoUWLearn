import type { SessionCookie } from "./cookieSource.js";

/**
 * A cookie as LEARN handed it back, carrying the attributes the storage state
 * needs so a rotated value can be written over the old one in place.
 */
export interface ParsedSetCookie extends SessionCookie {
  readonly path: string;
  /** Seconds since the epoch, or -1 for a session cookie, matching Playwright. */
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Parses one `Set-Cookie` header.
 *
 * Deliberately narrow: LEARN's session cookies are ordinary name/value pairs,
 * so this handles the attributes Playwright's storage state stores and ignores
 * the rest rather than pretending to be a complete RFC 6265 implementation.
 *
 * `defaultDomain` is the host that answered, because a Set-Cookie without a
 * Domain attribute is scoped to exactly that host.
 */
export function parseSetCookie(header: string, defaultDomain: string): ParsedSetCookie | null {
  const [pair, ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name) return null;

  let domain = defaultDomain;
  let cookiePath = "/";
  let expires = -1;
  let httpOnly = false;
  let secure = false;
  let sameSite: ParsedSetCookie["sameSite"];
  let maxAge: number | undefined;

  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? "" : attribute.slice(index + 1).trim();

    switch (key) {
      case "domain":
        if (attributeValue) domain = attributeValue.startsWith(".") ? attributeValue : `.${attributeValue}`;
        break;
      case "path":
        if (attributeValue) cookiePath = attributeValue;
        break;
      case "expires": {
        const parsed = Date.parse(attributeValue);
        if (!Number.isNaN(parsed)) expires = Math.floor(parsed / 1000);
        break;
      }
      case "max-age": {
        const seconds = Number(attributeValue);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
      case "httponly":
        httpOnly = true;
        break;
      case "secure":
        secure = true;
        break;
      case "samesite": {
        const normalized = attributeValue.toLowerCase();
        if (normalized === "strict") sameSite = "Strict";
        else if (normalized === "lax") sameSite = "Lax";
        else if (normalized === "none") sameSite = "None";
        break;
      }
    }
  }

  // Max-Age wins over Expires where both are present, per RFC 6265.
  if (maxAge !== undefined) expires = Math.floor(Date.now() / 1000) + maxAge;

  return { name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite };
}

/** Parses every `Set-Cookie` on one response, dropping any it cannot read. */
export function parseSetCookies(headers: readonly string[], defaultDomain: string): ParsedSetCookie[] {
  const parsed: ParsedSetCookie[] = [];
  for (const header of headers) {
    const cookie = parseSetCookie(header, defaultDomain);
    if (cookie) parsed.push(cookie);
  }
  return parsed;
}

/**
 * A deleted cookie: the server clears one by sending an empty value or a date
 * in the past. Absorbing either over a live session would log us out.
 */
export function isCookieCleared(cookie: ParsedSetCookie, now = Date.now()): boolean {
  if (cookie.value === "") return true;
  return cookie.expires >= 0 && cookie.expires * 1000 <= now;
}
