import fs from "node:fs";
import path from "node:path";
import {
  cookieHeaderFromCookies,
  cookieHeaderFromStorageState,
  REQUIRED_SESSION_COOKIES,
  type SessionCookie
} from "./cookieSource.js";
import { isCookieCleared, parseSetCookies, type ParsedSetCookie } from "./setCookie.js";

export interface CookieHeaderProviderOptions {
  /** Cookies from an open browser context, or null when none is running. */
  readonly liveCookies: () => Promise<readonly SessionCookie[] | null>;
  readonly storageStatePath: string;
  readonly host: string;
}

/**
 * Supplies the Cookie header for LEARN reads.
 *
 * A running browser context holds the freshest session, because Brightspace
 * rotates the session cookie as you browse and the snapshot on disk is only
 * rewritten when /auth/save runs. Fall back to that snapshot whenever the
 * context is absent, unauthenticated, or unreadable.
 */
export function createCookieHeaderProvider(options: CookieHeaderProviderOptions): () => Promise<string> {
  return async () => {
    try {
      const live = await options.liveCookies();
      if (live && live.length > 0) return cookieHeaderFromCookies(live, options.host);
    } catch {
      // Fall through: an unusable context is not a reason to fail the read.
    }
    return cookieHeaderFromStorageState(options.storageStatePath, options.host);
  };
}

export interface SessionCookieStore {
  /** The Cookie header for the next LEARN request. */
  header(): Promise<string>;
  /**
   * Folds the `Set-Cookie` headers of a LEARN response back into the snapshot.
   * Returns the names actually written, which is empty for the common case of
   * a response that rotated nothing.
   */
  absorb(setCookieHeaders: readonly string[]): readonly string[];
}

/**
 * The Cookie header, plus the write-back half that keeps it usable.
 *
 * Reads go out over `fetch`, which has no cookie jar: any session Brightspace
 * hands back in a `Set-Cookie` is discarded. That is how a session dies while
 * the heartbeat believes it is healthy — LEARN rotates `d2lSessionVal`, we keep
 * presenting the value from the last interactive login, and one day LEARN stops
 * accepting it. Writing the rotation back to the storage state closes that gap,
 * so the heartbeat extends a session we can still prove we own.
 *
 * Only cookies for the LEARN host are kept, and a cleared or expired one is
 * ignored rather than persisted: overwriting a live session with a logout is
 * the one mistake here that a user cannot recover from without logging in.
 */
export function createSessionCookieStore(options: CookieHeaderProviderOptions): SessionCookieStore {
  const header = createCookieHeaderProvider(options);

  return {
    header,

    absorb(setCookieHeaders: readonly string[]): readonly string[] {
      if (setCookieHeaders.length === 0) return [];

      const rotated = parseSetCookies(setCookieHeaders, options.host).filter(
        (cookie) =>
          REQUIRED_SESSION_COOKIES.includes(cookie.name as (typeof REQUIRED_SESSION_COOKIES)[number]) &&
          !isCookieCleared(cookie)
      );
      if (rotated.length === 0) return [];

      return persist(options.storageStatePath, rotated);
    }
  };
}

interface StorageState {
  cookies?: ParsedSetCookie[];
  origins?: unknown[];
}

const identity = (cookie: { name: string; domain: string; path?: string }): string =>
  `${cookie.name}\u001f${cookie.domain}\u001f${cookie.path ?? "/"}`;

/**
 * Merges rotated cookies into the storage state, preserving everything else in
 * the file — Playwright writes `origins` there too, and reads it back on the
 * next browser launch.
 *
 * Writes through a temporary file so a reader never sees a half-written jar.
 * Playwright rewrites this same path on /auth/save; an atomic rename means the
 * loser of that race is simply overwritten rather than corrupted.
 */
function persist(storageStatePath: string, rotated: readonly ParsedSetCookie[]): readonly string[] {
  let state: StorageState;
  try {
    state = JSON.parse(fs.readFileSync(storageStatePath, "utf8")) as StorageState;
  } catch {
    // No snapshot yet. Writing one from response cookies alone would produce a
    // jar with no browser profile behind it, which cannot be refreshed later.
    return [];
  }

  const jar = state.cookies ?? [];
  const byIdentity = new Map(jar.map((cookie) => [identity(cookie), cookie] as const));

  const written: string[] = [];
  for (const cookie of rotated) {
    const existing = byIdentity.get(identity(cookie));
    if (existing && existing.value === cookie.value) continue;
    byIdentity.set(identity(cookie), existing ? { ...existing, value: cookie.value, expires: cookie.expires } : cookie);
    written.push(cookie.name);
  }

  if (written.length === 0) return [];

  const next: StorageState = { ...state, cookies: [...byIdentity.values()] };
  const temporary = `${storageStatePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, storageStatePath);
  } catch {
    fs.rmSync(temporary, { force: true });
    // A snapshot we failed to update is still the one we are using; the next
    // response will offer the rotation again.
    return [];
  }

  return written;
}
