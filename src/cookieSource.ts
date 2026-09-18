import fs from "node:fs";

/**
 * LEARN answers 403 unless both session cookies are presented together;
 * either one alone is rejected.
 */
export const REQUIRED_SESSION_COOKIES = ["d2lSessionVal", "d2lSecureSessionVal"] as const;

export class MissingSessionCookiesError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `LEARN session cookies are missing: ${missing.join(", ")}. Open the local auth page and complete Waterloo SSO.`
    );
    this.name = "MissingSessionCookiesError";
    this.missing = missing;
  }
}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

type StorageStateCookie = SessionCookie;

/**
 * Renders a Cookie header from an already-loaded cookie jar, whichever side it
 * came from (a live browser context, or the storage state on disk).
 */
export function cookieHeaderFromCookies(cookies: readonly SessionCookie[], host: string): string {
  const relevant = cookies.filter((cookie) => matchesHost(cookie.domain, host));

  const present = new Set(relevant.map((cookie) => cookie.name));
  const missing = REQUIRED_SESSION_COOKIES.filter((name) => !present.has(name));
  if (missing.length > 0) throw new MissingSessionCookiesError(missing);

  return relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function matchesHost(cookieDomain: string, host: string): boolean {
  if (cookieDomain === host) return true;
  if (!cookieDomain.startsWith(".")) return false;
  const parent = cookieDomain.slice(1);
  return host === parent || host.endsWith(cookieDomain);
}

/** The saved cookie jar, or an empty one when there is no readable snapshot. */
export function cookiesFromStorageState(storageStatePath: string): StorageStateCookie[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storageStatePath, "utf8")) as {
      cookies?: StorageStateCookie[];
    };
    return parsed.cookies ?? [];
  } catch {
    return [];
  }
}

/**
 * Reads the Playwright storage state and renders a Cookie header for LEARN.
 *
 * Throws when either session cookie is absent, which is what a lapsed SSO
 * session looks like on disk. Failing here beats surfacing the 403 that LEARN
 * would otherwise return, because a 403 is also what an org unit you cannot see
 * returns, and the two demand different responses from the caller.
 */
export function cookieHeaderFromStorageState(storageStatePath: string, host: string): string {
  return cookieHeaderFromCookies(cookiesFromStorageState(storageStatePath), host);
}
