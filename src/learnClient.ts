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
  parseCourseHome,
  parseCoursesJson,
  parseTableLikePage
} from "./parsers.js";
import type { Course, DueItem, FetchTextResult, NormalizedCourse, ParsedPage } from "./types.js";

export class LearnClient {
  constructor(private readonly browser: BrowserSession) {}

  authStatus() {
    return this.browser.authStatus();
  }

  login() {
    return this.browser.startManualLogin();
  }

  authStart() {
    return this.browser.startManualLogin();
  }

  authReset() {
    return this.browser.resetSession();
  }

  authSave() {
    return this.browser.saveSessionState();
  }

  authSaveAndClose() {
    return this.browser.saveSessionAndClose();
  }

  async listCourses(pageSize = 100): Promise<{
    source: string;
    status: number;
    courses: Course[];
    raw?: unknown;
    parseError?: string;
    preview?: string;
  }> {
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
  }

  async getCourseHome(courseId: string) {
    const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(`/d2l/home/${courseId}`));
    return { source: response.url, status: response.status, ...parseCourseHome(response.text) };
  }

  async listContent(courseId: string) {
    const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(`/d2l/le/content/${courseId}/Home`));
    return { source: response.url, status: response.status, ...parseContent(response.text) };
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
    return {
      source: page.source,
      status: page.status,
      rows: page.rows,
      links: page.links.filter((link) => /news|announcement|\/news\//i.test(`${link.label} ${link.url}`)),
      text: page.text
    };
  }

  async listGrades(courseId: string) {
    return this.fetchParsedPage(`/d2l/lms/grades/my_grades/main.d2l?ou=${courseId}`);
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
    return {
      source: response.url,
      status: response.status,
      contentType: response.contentType,
      ...parseTableLikePage(response.text)
    };
  }

  private async fetchParsedPage(pathOrUrl: string) {
    const response = await this.fetchTextWithAuthCheck(absoluteLearnUrl(pathOrUrl));
    return {
      source: response.url,
      status: response.status,
      contentType: response.contentType,
      ...parseTableLikePage(response.text)
    };
  }

  private async fetchTextWithAuthCheck(
    url: string,
    init?: { headers?: Record<string, string> }
  ): Promise<FetchTextResult> {
    const first = await this.browser.fetchText(url, init);
    if (!isLoginPage(first)) return first;

    const status = await this.browser.authStatus({ navigate: false });
    throw new Error(JSON.stringify(authRequired(status)));
  }

  async findCourse(query: string, includeRaw = false) {
    const coursesResult = await this.listCourses(500);
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

  async dueItems(options: { courseQuery?: string; daysAhead?: number; includeRaw?: boolean } = {}) {
    const daysAhead = options.daysAhead ?? 14;
    const coursesResult = await this.listCourses(500);
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

  async dueDatesSummary(options: { courseQuery?: string; daysAhead?: number; includeRaw?: boolean } = {}) {
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

  async latestAnnouncements(options: { courseQuery: string; limit?: number; includeRaw?: boolean }) {
    const limit = options.limit ?? 5;
    const coursesResult = await this.listCourses(500);
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
    return {
      status: "ok",
      query: options.courseQuery,
      course,
      announcements: announcementsFromPage(page, course, limit)
    };
  }

  async courseDashboard(options: { courseQuery: string; daysAhead?: number; announcementLimit?: number }) {
    const daysAhead = options.daysAhead ?? 14;
    const announcementLimit = options.announcementLimit ?? 3;
    const coursesResult = await this.listCourses(500);
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
    return {
      status: "ok",
      query: options.courseQuery,
      course,
      latestAnnouncements: announcementsFromPage(news, course, announcementLimit),
      dueItems: filterUpcoming(due.items, daysAhead),
      dueErrors: due.errors,
      nav: home.nav
    };
  }

  async allCoursesDashboard(options: { daysAhead?: number; announcementLimit?: number } = {}) {
    const daysAhead = options.daysAhead ?? 14;
    const announcementLimit = options.announcementLimit ?? 1;
    const coursesResult = await this.listCourses(500);
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
