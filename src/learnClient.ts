import path from "node:path";
import { authRequired } from "./authTypes.js";
import { config, absoluteLearnUrl } from "./config.js";
import { BrowserSession } from "./browserSession.js";
import {
  announcementsFromPage,
  buildCourseResolution,
  dueItemsFromContent,
  dueItemsFromPage,
  dueItemsFromUpdates,
  filterUpcoming,
  normalizeAnnouncements,
  normalizeCourse
} from "./intelligence.js";
import {
  parseContent,
  parseContentItem,
  parseAnnouncementDetail,
  parseCourseHome,
  parseCoursesJson,
  parseTableLikePage
} from "./parsers.js";
import type { Announcement, Course, DueItem, FetchTextResult, NormalizedCourse, ParsedPage } from "./types.js";

const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
const CACHE_TTL = {
  courses: 10 * 60_000,
  announcements: 5 * 60_000,
  dueDates: 5 * 60_000,
  content: 30 * 60_000,
  grades: 2 * 60_000
};

export function clearLearnCache(): void {
  cache.clear();
}

export class LearnClient {
  constructor(private readonly browser: BrowserSession) {}

  authStatus(force = false) {
    return this.browser.authStatus({ force });
  }

  login() {
    return this.browser.startManualLogin();
  }

  authStart() {
    clearLearnCache();
    return this.browser.startManualLogin();
  }

  authReset() {
    clearLearnCache();
    return this.browser.resetSession();
  }

  authSave() {
    return this.browser.saveSessionState();
  }

  authSaveAndClose() {
    return this.browser.saveSessionAndClose();
  }

  async listCourses(pageSize = 100, refresh = false, includeRaw = false): Promise<{
    source: string;
    status: number;
    courses: Course[];
    raw?: unknown;
    parseError?: string;
    preview?: string;
  }> {
    const result = await this.cached(`courses:${pageSize}`, CACHE_TTL.courses, refresh, async () => {
      const url = absoluteLearnUrl(
        `/d2l/le/manageCourses/api/mycourses?pageSize=${encodeURIComponent(
          String(pageSize)
        )}&sort=current&autoPinCourses=false&orgUnitTypeId=3&promotePins=true&embedDepth=0`
      );
      const response = await this.fetchTextWithAuthCheck(url, { headers: { Accept: "application/json" } });
      let json: unknown;
      try {
        json = JSON.parse(response.text);
      } catch {
        return {
          source: response.url,
          status: response.status,
          courses: [],
          parseError: `Course endpoint did not return JSON. ${isLoginPage(response) ? "LEARN is at a login page." : "Check authentication."}`,
          preview: response.text.slice(0, 500)
        };
      }
      return { source: response.url, status: response.status, courses: parseCoursesJson(json), raw: json };
    });
    if (includeRaw) return result;
    return {
      source: result.source,
      status: result.status,
      courses: result.courses.map(({ raw: _raw, ...course }) => course),
      ...(result.parseError ? { parseError: result.parseError } : {}),
      ...(result.preview ? { preview: result.preview } : {})
    };
  }

  async getCourseHome(courseId: string) {
    const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(`/d2l/home/${courseId}`));
    return { source: response.url, status: response.status, ...parseCourseHome(response.text) };
  }

  async listContent(courseId: string, refresh = false) {
    return this.cached(`content:${courseId}`, CACHE_TTL.content, refresh, async () => {
      const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(`/d2l/le/content/${courseId}/Home`));
      return { source: response.url, status: response.status, ...parseContent(response.text) };
    });
  }

  async getContentItem(courseId: string, contentId: string) {
    const response = await this.fetchTextWithAuthCheck(
      absoluteLearnUrl(`/d2l/le/content/${courseId}/viewContent/${contentId}/View`)
    );
    return { source: response.url, status: response.status, ...parseContentItem(response.text) };
  }

  async downloadContentFile(url: string, filename?: string) {
    const parsed = new URL(url);
    if (parsed.hostname !== new URL(config.learnBaseUrl).hostname) {
      throw new Error(`Refusing to download non-LEARN URL: ${url}`);
    }
    if (!/\/content\/enforced\//i.test(parsed.pathname)) {
      throw new Error("Refusing to download URL that is not a LEARN enforced content file.");
    }

    const guessed = decodeURIComponent(path.basename(parsed.pathname)) || "learn-content-file";
    const safeName = sanitizeFilename(filename || guessed);
    const destination = path.resolve(config.downloadDir, safeName);
    const root = path.resolve(config.downloadDir);
    if (!destination.startsWith(root + path.sep) && destination !== root) {
      throw new Error("Download path escaped LEARN download directory.");
    }
    return this.browser.download(url, destination);
  }

  async listAnnouncements(courseId: string) {
    const page = await this.fetchParsedPage(`/d2l/lms/news/main.d2l?ou=${courseId}`);
    const rows = page.rows.filter((row) => Boolean(row.Title ?? row.Headline));
    const links = page.links.filter((link) => /news|announcement|\/news\//i.test(`${link.label} ${link.url}`));
    return {
      source: page.source,
      status: page.status,
      contentType: page.contentType,
      title: page.title,
      emptyState: page.emptyState,
      rows,
      links,
      text: rows.map((row) => `${row.Title ?? row.Headline ?? ""} ${row["Start Date"] ?? row.Date ?? ""}`.trim()).join("\n")
    };
  }

  async listGrades(courseId: string, refresh = false) {
    return this.cached(`grades:${courseId}`, CACHE_TTL.grades, refresh, () =>
      this.fetchParsedPage(`/d2l/lms/grades/my_grades/main.d2l?ou=${courseId}`)
    );
  }

  async listAssignments(courseId: string) {
    return this.fetchParsedPage(`/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}`);
  }

  async listQuizzes(courseId: string) {
    return this.fetchParsedPage(`/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`);
  }

  async listDiscussions(courseId: string) {
    return this.fetchParsedPage(`/d2l/le/${courseId}/discussions/List`);
  }

  async listCalendar(courseId: string) {
    return this.fetchParsedPage(`/d2l/le/calendar/${courseId}`);
  }

  async fetchPage(pathOrUrl: string) {
    const url = absoluteLearnUrl(pathOrUrl);
    if (new URL(url).hostname !== new URL(config.learnBaseUrl).hostname) {
      throw new Error(`Refusing to fetch non-LEARN URL: ${url}`);
    }
    const response = await this.fetchTextWithAuthCheck(url);
    return compactParsedPage({
      source: response.url,
      status: response.status,
      contentType: response.contentType,
      ...parseTableLikePage(response.text)
    });
  }

  private async fetchParsedPage(pathOrUrl: string) {
    const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(pathOrUrl));
    return compactParsedPage({
      source: response.url,
      status: response.status,
      contentType: response.contentType,
      ...parseTableLikePage(response.text)
    });
  }

  private async fetchTextWithAuthCheck(
    url: string,
    init?: { headers?: Record<string, string> }
  ): Promise<FetchTextResult> {
    let first: FetchTextResult;
    try {
      first = await this.browser.fetchText(url, init);
    } catch (error) {
      if (!isRetryableReadError(error)) throw error;
      first = await this.browser.fetchText(url, init);
    }
    if (!isLoginPage(first)) return first;

    clearLearnCache();
    const status = await this.browser.authStatus({ navigate: false, force: true });
    throw new Error(JSON.stringify(authRequired(status)));
  }

  private async cached<T>(key: string, ttlMs: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (!refresh && existing && existing.expiresAt > Date.now()) {
      return existing.value as Promise<T>;
    }
    const value = load().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }

  async findCourse(query: string, includeRaw = false, refresh = false) {
    const coursesResult = await this.listCourses(500, refresh, true);
    const matches = buildCourseResolution(coursesResult.courses, query).matches;
    return {
      query,
      matchCount: matches.length,
      matches: includeRaw
        ? matches.map((match) => ({
            ...match,
            raw: coursesResult.courses.find((course) => course.id === match.courseId)?.raw
          }))
        : matches
    };
  }

  async dueItems(options: { courseQuery?: string; daysAhead?: number; includeRaw?: boolean; refresh?: boolean } = {}) {
    const key = `due:${options.courseQuery ?? "*"}:${options.daysAhead ?? 14}`;
    return this.cached(key, CACHE_TTL.dueDates, options.refresh ?? false, () => this.loadDueItems(options));
  }

  private async loadDueItems(options: { courseQuery?: string; daysAhead?: number; includeRaw?: boolean; refresh?: boolean }) {
    const daysAhead = options.daysAhead ?? 14;
    const coursesResult = await this.listCourses(500, options.refresh, true);
    const resolution = buildCourseResolution(coursesResult.courses, options.courseQuery);
    if (resolution.status !== "resolved") {
      return {
        status: resolution.status,
        query: resolution.query,
        matches: resolution.matches,
        items: []
      };
    }

    const allItems: DueItem[] = [];
    const errors: Array<{ courseId: string; source: string; message: string }> = [];

    for (const course of resolution.matches) {
      const result = await this.collectDueItemsForCourse(course);
      allItems.push(...result.items);
      errors.push(...result.errors);
    }

    return {
      status: "ok",
      query: options.courseQuery,
      daysAhead,
      courses: resolution.matches,
      items: filterUpcoming(allItems, daysAhead),
      errors
    };
  }

  async dueDatesSummary(options: { courseQuery?: string; daysAhead?: number; includeRaw?: boolean; refresh?: boolean } = {}) {
    const result = await this.dueItems(options);
    if (result.status !== "ok") return result;
    const dueDateLines = result.items.map(formatDueItemLine);
    return {
      dueDateLines,
      items: result.items,
      itemCount: result.items.length,
      status: result.status,
      query: result.query,
      daysAhead: result.daysAhead,
      errorCount: result.errors.length,
      errors: result.errors,
      checkedCourseCount: result.courses.length,
      checkedCourses: result.courses.map((course) => ({
        courseId: course.courseId,
        courseName: course.courseName,
        courseCode: course.courseCode
      }))
    };
  }

  async latestAnnouncements(options: { courseQuery: string; limit?: number; includeRaw?: boolean; refresh?: boolean }) {
    const key = `announcements:${options.courseQuery}:${options.limit ?? 5}`;
    return this.cached(key, CACHE_TTL.announcements, options.refresh ?? false, () =>
      this.loadLatestAnnouncements(options)
    );
  }

  private async loadLatestAnnouncements(options: { courseQuery: string; limit?: number; includeRaw?: boolean; refresh?: boolean }) {
    const limit = options.limit ?? 5;
    const coursesResult = await this.listCourses(500, options.refresh, true);
    const resolution = buildCourseResolution(coursesResult.courses, options.courseQuery);
    if (resolution.status !== "resolved") {
      return {
        status: resolution.status,
        query: resolution.query,
        matches: resolution.matches,
        announcements: []
      };
    }

    const course = resolution.matches[0];
    const page = await this.fetchParsedPage(`/d2l/lms/news/main.d2l?ou=${course.courseId}`);
    const summaries = announcementsFromPage(page, course, limit);
    const announcements = await Promise.all(summaries.map((announcement) => this.loadAnnouncementBody(announcement)));
    return {
      status: "ok",
      query: options.courseQuery,
      course,
      announcements
    };
  }

  private async loadAnnouncementBody(announcement: Announcement): Promise<Announcement> {
    if (!announcement.url) {
      return {
        ...announcement,
        body: "",
        contentStatus: "unavailable",
        attachments: [],
        warning: "No announcement detail URL was available."
      };
    }
    try {
      let rendered;
      try {
        rendered = await this.browser.fetchRendered(announcement.url);
      } catch (error) {
        if (!isRetryableReadError(error)) throw error;
        rendered = await this.browser.fetchRendered(announcement.url);
      }
      if (isLoginPage(rendered)) {
        clearLearnCache();
        const status = await this.browser.authStatus({ navigate: false, force: true });
        throw new Error(JSON.stringify(authRequired(status)));
      }
      return { ...announcement, ...parseAnnouncementDetail(rendered) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("{")) throw error;
      return {
        ...announcement,
        body: "",
        contentStatus: "unavailable",
        attachments: [],
        warning: `Unable to read the rendered announcement body: ${message}`
      };
    }
  }

  async courseDashboard(options: { courseQuery: string; daysAhead?: number; announcementLimit?: number; refresh?: boolean }) {
    const daysAhead = options.daysAhead ?? 14;
    const announcementLimit = options.announcementLimit ?? 3;
    const coursesResult = await this.listCourses(500, options.refresh, true);
    const resolution = buildCourseResolution(coursesResult.courses, options.courseQuery);
    if (resolution.status !== "resolved") {
      return {
        status: resolution.status,
        query: resolution.query,
        matches: resolution.matches
      };
    }

    const course = resolution.matches[0];
    const [home, news, due] = await Promise.all([
      this.getCourseHome(course.courseId),
      this.fetchParsedPage(`/d2l/lms/news/main.d2l?ou=${course.courseId}`),
      this.collectDueItemsForCourse(course)
    ]);
    const latestAnnouncements = await Promise.all(
      announcementsFromPage(news, course, announcementLimit).map((announcement) =>
        this.loadAnnouncementBody(announcement)
      )
    );
    return {
      status: "ok",
      query: options.courseQuery,
      course,
      latestAnnouncements,
      dueItems: filterUpcoming(due.items, daysAhead),
      dueErrors: due.errors,
      nav: home.nav
    };
  }

  async allCoursesDashboard(options: { daysAhead?: number; announcementLimit?: number; refresh?: boolean } = {}) {
    const daysAhead = options.daysAhead ?? 14;
    const announcementLimit = options.announcementLimit ?? 1;
    const coursesResult = await this.listCourses(500, options.refresh, true);
    const courses = buildCourseResolution(coursesResult.courses).matches;
    const summaries = [];
    const allDueItems: DueItem[] = [];
    const errors: Array<{ courseId: string; source: string; message: string }> = [];

    for (const course of courses) {
      const [homeResult, newsResult, dueResult] = await Promise.allSettled([
        this.getCourseHome(course.courseId),
        this.fetchParsedPage(`/d2l/lms/news/main.d2l?ou=${course.courseId}`),
        this.collectDueItemsForCourse(course)
      ]);
      const latestAnnouncements =
        newsResult.status === "fulfilled"
          ? announcementsFromPage(newsResult.value, course, announcementLimit)
          : [];
      const nav = homeResult.status === "fulfilled" ? homeResult.value.nav : [];
      if (homeResult.status === "rejected") {
        errors.push({ courseId: course.courseId, source: "home", message: String(homeResult.reason) });
      }
      if (newsResult.status === "rejected") {
        errors.push({ courseId: course.courseId, source: "news", message: String(newsResult.reason) });
      }
      if (dueResult.status === "fulfilled") {
        allDueItems.push(...dueResult.value.items);
        errors.push(...dueResult.value.errors);
      } else {
        errors.push({ courseId: course.courseId, source: "due", message: String(dueResult.reason) });
      }
      summaries.push({
        course,
        latestAnnouncements,
        nav,
        dueItems:
          dueResult.status === "fulfilled" ? filterUpcoming(dueResult.value.items, daysAhead) : []
      });
    }

    return {
      status: "ok",
      daysAhead,
      courses,
      dueItems: filterUpcoming(allDueItems, daysAhead),
      summaries,
      errors
    };
  }

  private async collectDueItemsForCourse(course: NormalizedCourse) {
    const items: DueItem[] = [];
    const errors: Array<{ courseId: string; source: string; message: string }> = [];

    const collectPage = async (
      source: "assignment" | "quiz" | "calendar",
      fetcher: () => Promise<ParsedPage>
    ) => {
      try {
        const page = await fetcher();
        items.push(...dueItemsFromPage(page, course, source));
      } catch (error) {
        errors.push({ courseId: course.courseId, source, message: String(error) });
      }
    };

    await Promise.all([
      collectPage("assignment", () => this.listAssignments(course.courseId) as Promise<ParsedPage>),
      collectPage("quiz", () => this.listQuizzes(course.courseId) as Promise<ParsedPage>),
      collectPage("calendar", () => this.listCalendar(course.courseId) as Promise<ParsedPage>),
      (async () => {
        try {
          const content = await this.listContent(course.courseId);
          items.push(...dueItemsFromContent(content.topics, content.source, course));
        } catch (error) {
          errors.push({ courseId: course.courseId, source: "content", message: String(error) });
        }
      })(),
      (async () => {
        try {
          const home = await this.getCourseHome(course.courseId);
          items.push(...dueItemsFromUpdates(home.updates, home.source, course));
        } catch (error) {
          errors.push({ courseId: course.courseId, source: "home", message: String(error) });
        }
      })()
    ]);

    return { items, errors };
  }
}

function sanitizeFilename(input: string): string {
  return input.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 180) || "learn-content-file";
}

function formatDueItemLine(item: DueItem): string {
  const when = item.dueText ?? item.dueAt ?? "No due date";
  const status = item.status ? ` [${item.status}]` : "";
  return `${when} — ${item.courseName} — ${item.title}${status}`;
}

function isLoginPage(response: FetchTextResult): boolean {
  return (
    /\/adfs\/|login|signin|saml/i.test(response.url) ||
    /\b(sign in|username|password|multi-factor authentication|verification code|duo|approve)\b/i.test(
      response.text.slice(0, 5000)
    )
  );
}

function isRetryableReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|net::ERR_|navigation failed|connection reset|socket hang up/i.test(message);
}

function compactParsedPage<T extends ParsedPage>(page: T): T {
  return {
    ...page,
    rows: page.rows.slice(0, 200),
    links: page.links.slice(0, 250),
    text: page.text.slice(0, 20_000)
  };
}
