const DEFAULT_BASE_URL = "https://learn.uwaterloo.ca";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 3;

export class LearnHttpError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`LEARN answered ${status} for ${path}`);
    this.name = "LearnHttpError";
    this.status = status;
  }
}

/** The SSO session has lapsed; the caller must re-authenticate through a browser. */
export class LearnAuthError extends Error {
  readonly status = 403;

  constructor(path: string) {
    super(`LEARN session has expired (403 for ${path}). Open the local auth page and complete Waterloo SSO.`);
    this.name = "LearnAuthError";
  }
}

/** The session is live but this org unit is not visible to the user. */
export class LearnPermissionError extends Error {
  readonly status = 403;

  constructor(path: string) {
    super(`LEARN denied access to ${path}. The session is valid, so this org unit is not visible to you.`);
    this.name = "LearnPermissionError";
  }
}

export class LearnNetworkError extends Error {
  constructor(path: string, cause: unknown) {
    super(`LEARN request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LearnNetworkError";
  }
}

export interface LearnApiOptions {
  readonly baseUrl?: string;
  readonly cookieHeader: () => string | Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: (attempt: number) => number;
}

export interface ApiVersions {
  readonly le: string;
  readonly lp: string;
}

export interface LearnApi {
  warmUp(): Promise<ApiVersions>;
  versions(): Promise<ApiVersions>;
  getJson<T = unknown>(path: string): Promise<T>;
  courses<T = unknown>(): Promise<T>;
  grades<T = unknown>(orgUnitId: number | string): Promise<T>;
  assignments<T = unknown>(orgUnitId: number | string): Promise<T>;
  quizzes<T = unknown>(orgUnitId: number | string): Promise<T>;
  announcements<T = unknown>(orgUnitId: number | string): Promise<T>;
  contentToc<T = unknown>(orgUnitId: number | string): Promise<T>;
}

/** Caps how many requests are in flight against LEARN at any moment. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const isTransient = (status: number): boolean => status === 429 || status >= 500;

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export function createLearnApi(options: LearnApiOptions): LearnApi {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? ((attempt: number) => 250 * 2 ** attempt);
  const limited = createSemaphore(options.concurrency ?? DEFAULT_CONCURRENCY);

  let versionsPromise: Promise<ApiVersions> | undefined;

  const headers = async (): Promise<Record<string, string>> => ({
    // Reads need only the session cookies; LEARN does not require an XSRF
    // header on GET, and sending one is not enough to authenticate without them.
    Cookie: await options.cookieHeader(),
    Accept: "application/json"
  });

  const send = async (path: string): Promise<Response> => {
    const url = new URL(path, baseUrl).toString();
    const requestHeaders = await headers();
    return limited(() => fetchImpl(url, { redirect: "manual", headers: requestHeaders }));
  };

  /**
   * A 403 means either a dead session or an org unit the user cannot see, and
   * the body does not distinguish them. whoami is the cheapest oracle: it
   * succeeds for any live session.
   */
  const classifyForbidden = async (path: string): Promise<Error> => {
    const { lp } = await versions();
    try {
      const probe = await send(`/d2l/api/lp/${lp}/users/whoami`);
      return probe.ok ? new LearnPermissionError(path) : new LearnAuthError(path);
    } catch {
      return new LearnAuthError(path);
    }
  };

  async function getJson<T>(path: string): Promise<T> {
    let lastStatus = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await send(path);
      } catch (cause) {
        if (attempt === maxRetries) throw new LearnNetworkError(path, cause);
        await sleep(retryDelayMs(attempt));
        continue;
      }

      if (response.ok) return (await response.json()) as T;
      if (response.status === 403) throw await classifyForbidden(path);

      lastStatus = response.status;
      if (!isTransient(lastStatus) || attempt === maxRetries) throw new LearnHttpError(lastStatus, path);
      await sleep(retryDelayMs(attempt));
    }

    throw new LearnHttpError(lastStatus, path);
  }

  async function versions(): Promise<ApiVersions> {
    versionsPromise ??= (async () => {
      const products = await getJson<Array<{ ProductCode: string; LatestVersion: string }>>("/d2l/api/versions/");
      const latest = new Map(products.map((product) => [product.ProductCode, product.LatestVersion]));
      return { le: latest.get("le") ?? "1.0", lp: latest.get("lp") ?? "1.0" };
    })();
    return versionsPromise;
  }

  const le = async (orgUnitId: number | string, suffix: string): Promise<string> =>
    `/d2l/api/le/${(await versions()).le}/${orgUnitId}/${suffix}`;

  return {
    versions,
    warmUp: versions,
    getJson,

    courses: <T>() =>
      getJson<T>(
        "/d2l/le/manageCourses/api/mycourses?pageSize=100&sort=current&autoPinCourses=false&orgUnitTypeId=3&promotePins=true&embedDepth=0"
      ),

    grades: async <T>(ou: number | string) => getJson<T>(await le(ou, "grades/values/myGradeValues/")),
    assignments: async <T>(ou: number | string) => getJson<T>(await le(ou, "dropbox/folders/")),
    quizzes: async <T>(ou: number | string) => getJson<T>(await le(ou, "quizzes/")),
    announcements: async <T>(ou: number | string) => getJson<T>(await le(ou, "news/")),
    contentToc: async <T>(ou: number | string) => getJson<T>(await le(ou, "content/toc"))
  };
}
