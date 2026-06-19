import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AuthStatus, AuthState } from "./authTypes.js";
import { config } from "./config.js";
import type { FetchTextResult } from "./types.js";

interface PageFetchResult extends FetchTextResult {
  redirected: boolean;
}

export class BrowserSession {
  private context?: BrowserContext;
  private contextPromise?: Promise<BrowserContext>;
  private currentHeadless?: boolean;
  private navigationQueue: Promise<unknown> = Promise.resolve();

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
    const existing = context.pages().find((page) => !page.isClosed());
    if (existing) return existing;
    return context.newPage();
  }

  async openLogin(): Promise<{ url: string; title: string }> {
    return this.withNavigationLock(async () => {
      const page = await this.ensurePage({ headless: false });
      await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
        waitUntil: "domcontentloaded"
      });
      return { url: page.url(), title: await page.title() };
    });
  }

  async startManualLogin(): Promise<AuthStatus> {
    await this.openLogin();
    return this.authStatus({ navigate: false });
  }

  async authStatus(options: { navigate?: boolean } = {}): Promise<AuthStatus> {
    return this.withNavigationLock(async () => {
      const page = await this.ensurePage();
      if (options.navigate !== false) {
        await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
          waitUntil: "domcontentloaded"
        });
      }
      return this.authStatusFromPage(page);
    });
  }

  async fetchText(url: string, init?: { headers?: Record<string, string> }): Promise<FetchTextResult> {
    return this.withNavigationLock(() => this.fetchTextUnlocked(url, init));
  }

  private async fetchTextUnlocked(url: string, init?: { headers?: Record<string, string> }): Promise<FetchTextResult> {
    const page = await this.ensurePage();
    await this.ensureLearnOrigin(page);

    await page.setExtraHTTPHeaders(init?.headers ?? {});
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded"
    });
    if (!response) {
      throw new Error(`No response while navigating to ${url}`);
    }

    return {
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      contentType: response.headers()["content-type"] ?? "",
      text: await response.text().catch(() => page.locator("body").innerText())
    };
  }

  private async withNavigationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.navigationQueue;
    let release!: () => void;
    this.navigationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async download(url: string, destinationPath: string): Promise<{
    url: string;
    status: number;
    contentType: string;
    bytes: number;
    path: string;
  }> {
    const context = await this.ensureContext();
    const response = await context.request.get(url, {
      headers: {
        Accept: "*/*"
      }
    });
    const body = await response.body();
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, body);
    return {
      url,
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      bytes: body.byteLength,
      path: destinationPath
    };
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
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

  private async ensureLearnOrigin(page: Page): Promise<void> {
    const learnHost = new URL(config.learnBaseUrl).hostname;
    const current = page.url();
    let currentHost: string | undefined;
    try {
      currentHost = current === "about:blank" ? undefined : new URL(current).hostname;
    } catch {
      currentHost = undefined;
    }
    if (currentHost === learnHost) return;

    await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
      waitUntil: "domcontentloaded"
    });
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
