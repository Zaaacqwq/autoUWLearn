import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AuthStatus, AuthState } from "./authTypes.js";
import { config } from "./config.js";

export class BrowserSession {
  private context?: BrowserContext;
  private contextPromise?: Promise<BrowserContext>;
  private currentHeadless?: boolean;
  private authPage?: Page;
  private cachedAuth?: { status: AuthStatus; expiresAt: number };

  async ensureContext(options: { headless?: boolean } = {}): Promise<BrowserContext> {
    if (this.context && options.headless === undefined) return this.context;

    const desiredHeadless = options.headless ?? config.headless;
    if (this.context && this.currentHeadless === desiredHeadless) return this.context;
    if (this.context && options.headless !== undefined && this.currentHeadless !== desiredHeadless) {
      await this.close();
    }
    if (this.contextPromise) return this.contextPromise;

    this.contextPromise = (async () => {
      await fs.mkdir(config.profileDir, { recursive: true });
      await fs.mkdir(config.downloadDir, { recursive: true });

      this.context = await chromium.launchPersistentContext(config.profileDir, {
        headless: desiredHeadless,
        acceptDownloads: true,
        downloadsPath: config.downloadDir
      });
      this.currentHeadless = desiredHeadless;
      this.context.on("close", () => {
        this.context = undefined;
        this.currentHeadless = undefined;
      });
      this.context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
      this.context.setDefaultTimeout(config.navigationTimeoutMs);
      await this.restoreSessionState(this.context);
      return this.context;
    })().finally(() => {
      this.contextPromise = undefined;
    });

    return this.contextPromise;
  }

  async ensurePage(options: { headless?: boolean } = {}): Promise<Page> {
    const context = await this.ensureContext(options);
    if (this.authPage && !this.authPage.isClosed()) return this.authPage;
    this.authPage = context.pages().find((page) => !page.isClosed()) ?? (await context.newPage());
    this.authPage.on("close", () => {
      this.authPage = undefined;
    });
    return this.authPage;
  }

  async openLogin(): Promise<{ url: string; title: string }> {
    const page = await this.ensurePage({ headless: false });
    await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
      waitUntil: "domcontentloaded"
    });
    return { url: page.url(), title: await page.title() };
  }

  async startManualLogin(): Promise<AuthStatus> {
    this.cachedAuth = undefined;
    await this.openLogin();
    return this.authStatus({ navigate: false, force: true });
  }

  async authStatus(
    options: { navigate?: boolean; force?: boolean; headless?: boolean } = {}
  ): Promise<AuthStatus> {
    if (!options.force && this.cachedAuth && this.cachedAuth.expiresAt > Date.now()) {
      return this.cachedAuth.status;
    }
    const page = await this.ensurePage(
      options.headless === undefined ? {} : { headless: options.headless }
    );
    if (options.navigate !== false) {
      await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
        waitUntil: "domcontentloaded"
      });
    }
    const status = await this.authStatusFromPage(page);
    this.cachedAuth = { status, expiresAt: Date.now() + 30_000 };
    return status;
  }

  /**
   * Cookies from the open browser context, or null when none is running.
   *
   * Never launches a browser: callers use this to prefer a live session over
   * the snapshot on disk, and a read must not pay for a browser start-up.
   */
  async liveCookies(): Promise<Array<{ name: string; value: string; domain: string }> | null> {
    if (!this.context) return null;
    return this.context.cookies().catch(() => null);
  }

  /**
   * Re-establishes a lapsed LEARN session without a human.
   *
   * Navigating to /d2l/home replays the SSO handshake. Waterloo's upstream
   * identity provider outlives the Brightspace session, and Duo remembers this
   * device for weeks, so the redirect usually lands back on the homepage already
   * authenticated. Runs headless: nothing appears on the server's display.
   *
   * Returns false when SSO wants a password, which only a human can supply.
   */
  async refreshSession(): Promise<boolean> {
    // Explicitly headless when we start the browser ourselves: this runs
    // unattended on a server, where a window nobody can see is at best startup
    // cost and at worst a hang, and LEARN_HEADLESS exists for interactive login
    // rather than to decide what recovery does. An already-open context is left
    // alone — switching modes closes it, and it may be the very window a human
    // is completing SSO in right now.
    const status = await this.authStatus({
      navigate: true,
      force: true,
      ...(this.context ? {} : { headless: true })
    });
    if (!status.authenticated) return false;
    await this.saveSessionState().catch(() => undefined);
    return true;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.authPage = undefined;
    this.cachedAuth = undefined;
    this.currentHeadless = undefined;
  }

  async saveSessionState(): Promise<AuthStatus> {
    const status = await this.authStatus({ navigate: false });
    if (!status.authenticated) return status;
    await fs.mkdir(path.dirname(config.storageStatePath), { recursive: true });
    await this.context?.storageState({ path: config.storageStatePath });
    return {
      ...status,
      message: `UW LEARN session is active and saved to ${config.storageStatePath}.`
    };
  }

  async saveSessionAndClose(): Promise<AuthStatus> {
    const status = await this.saveSessionState();
    if (status.authenticated) {
      await this.close();
      return {
        ...status,
        message: `UW LEARN session was saved to ${config.storageStatePath}. Browser closed; future MCP requests will restore the saved cookies headlessly.`
      };
    }
    return status;
  }

  async resetSession(): Promise<AuthStatus> {
    await this.close();
    const backupPath = `${config.profileDir}.bak-${Date.now()}`;
    await fs.rename(config.profileDir, backupPath).catch(() => undefined);
    await fs.rm(config.storageStatePath, { force: true }).catch(() => undefined);
    this.cachedAuth = undefined;
    return {
      ok: false,
      authenticated: false,
      state: "NOT_LOGGED_IN",
      url: "about:blank",
      title: "",
      message: `Session profile reset. Previous profile moved to ${backupPath}; saved storage state deleted. Start login again.`,
      authUrl: config.authUrl
    };
  }

  private async authStatusFromPage(page: Page): Promise<AuthStatus> {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const state = detectLoginState(url, title, bodyText);
    const authenticated = state === "LOGGED_IN";
    if (authenticated) {
      await fs.mkdir(path.dirname(config.storageStatePath), { recursive: true }).catch(() => undefined);
      await page.context().storageState({ path: config.storageStatePath }).catch(() => undefined);
    }
    return {
      ok: authenticated,
      authenticated,
      state,
      url,
      title,
      message: messageForState(state),
      authUrl: config.authUrl
    };
  }

  private async restoreSessionState(context: BrowserContext): Promise<void> {
    try {
      const raw = await fs.readFile(config.storageStatePath, "utf8");
      const state = JSON.parse(raw) as {
        cookies?: Parameters<BrowserContext["addCookies"]>[0];
      };
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
      }
    } catch {
      // No saved storage state yet, or it is unreadable. The persistent profile is still used.
    }
  }
}

function detectLoginState(url: string, title: string, bodyText: string): AuthState {
  const text = `${title}\n${bodyText}`.slice(0, 12_000);
  if (/\/d2l\/home/i.test(url) && /\b(My Courses|Course|Homepage|Brightspace)\b/i.test(text)) return "LOGGED_IN";
  if (/\/d2l\//i.test(url) && /\b(My Courses|Course|Brightspace|navbar|profile)\b/i.test(text)) return "LOGGED_IN";
  if (/\b(approve sign in request|approve.*phone|push notification|check your.*phone)\b/i.test(text)) {
    return "MFA_PUSH_WAITING";
  }
  if (/\b(enter code|verification code|code displayed|number shown|authenticator code)\b/i.test(text)) {
    return "MFA_CODE_REQUIRED";
  }
  if (/\b(Duo|Microsoft Authenticator|Verify your identity|multi-factor|multifactor|two-step|two factor)\b/i.test(text)) {
    return "MFA_REQUIRED";
  }
  if (/\b(password|enter password)\b/i.test(text) || /pwd|passwd|password/i.test(url)) return "PASSWORD_REQUIRED";
  if (/adfs|login\.microsoftonline|signin|saml|login/i.test(url) || /\b(sign in|University of Waterloo)\b/i.test(text)) {
    return "LOGIN_PAGE";
  }
  if (url === "about:blank") return "UNKNOWN";
  return "NOT_LOGGED_IN";
}

function messageForState(state: AuthState): string {
  switch (state) {
    case "LOGGED_IN":
      return "UW LEARN session is active.";
    case "PASSWORD_REQUIRED":
      return "Complete Waterloo password entry in the opened browser window.";
    case "MFA_REQUIRED":
    case "MFA_PUSH_WAITING":
      return "Complete MFA in the opened browser window or approve the request on your phone.";
    case "MFA_CODE_REQUIRED":
      return "Enter the MFA verification code in the opened browser window.";
    case "LOGIN_PAGE":
    case "NOT_LOGGED_IN":
    case "SESSION_EXPIRED":
      return "UW LEARN login is required. Open the local auth page and complete Waterloo SSO/MFA.";
    default:
      return "UW LEARN auth state is unknown. Check the local auth page.";
  }
}
