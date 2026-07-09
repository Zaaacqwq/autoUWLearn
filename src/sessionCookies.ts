import {
  cookieHeaderFromCookies,
  cookieHeaderFromStorageState,
  type SessionCookie
} from "./cookieSource.js";

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
