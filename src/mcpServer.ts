import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired } from "./authTypes.js";
import { BrowserSession } from "./browserSession.js";
import { config } from "./config.js";
import { MissingSessionCookiesError } from "./cookieSource.js";
import { createLearnApi, LearnAuthError } from "./learnApi.js";
import { LearnClient } from "./learnClient.js";
import { createLearnService, type LearnService } from "./learnService.js";
import { createCookieHeaderProvider } from "./sessionCookies.js";
import { recordToolDoc, zodRawShapeToJson } from "./toolRegistry.js";
import {
  AnnouncementsFeedSchema,
  AuthStatusSchema,
  ContentItemResultSchema,
  ContentResultSchema,
  CourseHomeSchema,
  CourseResolutionSchema,
  CoursesResultSchema,
  DashboardSchema,
  DownloadResultSchema,
  GradesResultSchema,
  MergedCoursesResultSchema,
  ParsedPageSchema,
  UpcomingResultSchema,
  schemaToJson
} from "./toolSchemas.js";

export interface LearnMcpServerHandle {
  server: McpServer;
  browser: BrowserSession;
}

export interface LearnMcpServerDeps {
  /** Injected by tests; otherwise built from the browser session's cookies. */
  service?: LearnService;
}

export function createLearnMcpServer(
  browser = new BrowserSession(),
  deps: LearnMcpServerDeps = {}
): LearnMcpServerHandle {
  const learn = new LearnClient(browser);

  // Reads go straight to the Valence JSON API over the session cookies. The
  // browser is only needed to establish that session, never to serve a read.
  const service =
    deps.service ??
    createLearnService({
      api: createLearnApi({
        baseUrl: config.learnBaseUrl,
        cookieHeader: createCookieHeaderProvider({
          liveCookies: () => browser.liveCookies(),
          storageStatePath: config.storageStatePath,
          host: new URL(config.learnBaseUrl).hostname
        })
      })
    });

  const server = new McpServer({
    name: "autouwlearn",
    version: "0.1.0"
  });

  function jsonResult(value: unknown, options: { isError?: boolean; structured?: boolean } = {}) {
    const structuredContent =
      options.structured && value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: options.structured && !options.isError
            ? "Structured tool result is available in structuredContent."
            : JSON.stringify(value, null, 2)
        }
      ],
      ...(structuredContent ? { structuredContent } : {}),
      ...(options.isError ? { isError: true } : {})
    };
  }

  function registerReadOnlyTool(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (input: Record<string, unknown>) => Promise<unknown> | unknown,
    options: { requiresAuth?: boolean; outputSchema?: z.ZodTypeAny } = { requiresAuth: true }
  ) {
    recordToolDoc({
      name,
      description,
      inputSchema: zodRawShapeToJson(inputSchema),
      outputSchema: options.outputSchema ? schemaToJson(options.outputSchema) : undefined
    });
    (server.registerTool as any)(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        },
        securitySchemes: [{ type: "oauth2", scopes: ["learn.read"] }],
        ...(options.outputSchema ? { outputSchema: options.outputSchema, _meta: { outputJsonSchema: schemaToJson(options.outputSchema) } } : {})
      },
      async (input: Record<string, unknown>) => {
        try {
          if (options.requiresAuth) {
            const status = await learn.authStatus(false);
            if (!status.authenticated) return jsonResult(authRequired(status), { isError: true });
          }
          return jsonResult(await withToolTimeout(handler(input), name), { structured: Boolean(options.outputSchema) });
        } catch (error) {
          // A lapsed SSO session surfaces as a 403 from the API or as absent
          // cookies on disk. Either way the fix is the same: log in again.
          if (error instanceof LearnAuthError || error instanceof MissingSessionCookiesError) {
            return jsonResult(
              authRequired({
                ok: false,
                authenticated: false,
                state: "SESSION_EXPIRED",
                url: config.learnBaseUrl,
                title: "",
                message: error.message,
                authUrl: config.authUrl
              }),
              { isError: true }
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("{")) {
            try {
              return jsonResult(JSON.parse(message), { isError: true });
            } catch {
              return jsonResult({ ok: false, error: "UNKNOWN_ERROR", message }, { isError: true });
            }
          }
          return jsonResult(classifyToolError(message), { isError: true });
        }
      }
    );
  }

  registerReadOnlyTool(
    "learn_auth_status",
    "Check whether the Playwright browser profile is currently authenticated to Waterloo LEARN.",
    {},
    async () => learn.authStatus(true),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_login",
    "Start manual Waterloo LEARN login in the persistent Playwright browser session. No UW password is stored or sent to ChatGPT.",
    {},
    async () => learn.authStart(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_start",
    "Start manual Waterloo LEARN login and return the local auth page URL/status.",
    {},
    async () => learn.authStart(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_reset",
    "Reset the saved Playwright session profile. Use only when login state is broken; requires logging in again.",
    {},
    async () => learn.authReset(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_save",
    "Save the current authenticated UW LEARN Playwright storage state so it can be restored after the browser closes.",
    {},
    async () => learn.authSave(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_save_and_close",
    "Save the current authenticated UW LEARN storage state and close the visible Playwright browser. Future reads restore cookies headlessly.",
    {},
    async () => learn.authSaveAndClose(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_list_courses",
    "List courses visible on the LEARN homepage using the Brightspace mycourses endpoint.",
    {
      pageSize: z.number().int().min(1).max(500).default(100).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ pageSize, includeRaw, refresh }) => learn.listCourses((pageSize as number | undefined) ?? 100, Boolean(refresh), Boolean(includeRaw)),
    { outputSchema: CoursesResultSchema }
  );

  registerReadOnlyTool(
    "learn_courses",
    "List the user's current UW LEARN courses. Each course merges its org units (lecture, lab, sections) under one label such as 'ECE 318'. Pass a course's label or key to the other tools; never pass an orgUnitId.",
    {},
    async () => {
      const courses = await service.courses();
      return { count: courses.length, courses };
    },
    { requiresAuth: false, outputSchema: MergedCoursesResultSchema }
  );

  registerReadOnlyTool(
    "learn_find_course",
    "Find visible LEARN courses by course id, course code, or natural query such as ECE 350. Returns all matches instead of guessing when ambiguous.",
    {
      query: z.string().min(1),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ query, includeRaw, refresh }) => learn.findCourse(query as string, Boolean(includeRaw), Boolean(refresh)),
    { outputSchema: CourseResolutionSchema }
  );

  const upcomingInput = {
    courseQuery: z.string().min(1).optional(),
    daysAhead: z.number().int().min(1).max(180).default(14).optional()
  };

  const upcomingHandler = async (input: Record<string, unknown>) => {
    const daysAhead = (input.daysAhead as number | undefined) ?? 14;
    const result = await service.upcoming({
      courseQuery: input.courseQuery as string | undefined,
      daysAhead
    });
    return { ...result, daysAhead, itemCount: result.items.length };
  };

  const upcomingDescription =
    "Every assignment and quiz due in the next N days, across all courses at once. Omit courseQuery to cover all courses. Read the items array; courses and errors are metadata. This is the tool to answer 'what is due this week'.";

  registerReadOnlyTool("learn_due_dates", upcomingDescription, upcomingInput, upcomingHandler, {
    requiresAuth: false,
    outputSchema: UpcomingResultSchema
  });

  registerReadOnlyTool("learn_due_items", upcomingDescription, upcomingInput, upcomingHandler, {
    requiresAuth: false,
    outputSchema: UpcomingResultSchema
  });

  const announcementsInput = {
    courseQuery: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).default(10).optional()
  };

  const announcementsHandler = async (input: Record<string, unknown>) => {
    const result = await service.announcements({
      courseQuery: input.courseQuery as string | undefined,
      limit: (input.limit as number | undefined) ?? 10
    });
    return { ...result, itemCount: result.items.length };
  };

  const announcementsDescription =
    "Recent announcements, newest first, with their full text. Omit courseQuery to cover all courses. This is the tool to answer 'what is the latest announcement'.";

  registerReadOnlyTool("learn_announcements", announcementsDescription, announcementsInput, announcementsHandler, {
    requiresAuth: false,
    outputSchema: AnnouncementsFeedSchema
  });

  registerReadOnlyTool(
    "learn_latest_announcements",
    announcementsDescription,
    announcementsInput,
    announcementsHandler,
    { requiresAuth: false, outputSchema: AnnouncementsFeedSchema }
  );

  registerReadOnlyTool(
    "learn_course_dashboard",
    "Return a concise dashboard for one resolved course: latest announcements, upcoming due items, and useful navigation links.",
    {
      courseQuery: z.string().min(1),
      daysAhead: z.number().int().min(1).max(180).default(14).optional(),
      announcementLimit: z.number().int().min(1).max(20).default(3).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseQuery, daysAhead, announcementLimit, refresh }) =>
      learn.courseDashboard({
        courseQuery: courseQuery as string,
        daysAhead: (daysAhead as number | undefined) ?? 14,
        announcementLimit: (announcementLimit as number | undefined) ?? 3,
        refresh: Boolean(refresh)
      }),
    { outputSchema: DashboardSchema }
  );

  registerReadOnlyTool(
    "learn_all_courses_dashboard",
    "Return a concise dashboard across all active visible courses.",
    {
      daysAhead: z.number().int().min(1).max(180).default(14).optional(),
      announcementLimit: z.number().int().min(1).max(20).default(1).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ daysAhead, announcementLimit, refresh }) =>
      learn.allCoursesDashboard({
        daysAhead: (daysAhead as number | undefined) ?? 14,
        announcementLimit: (announcementLimit as number | undefined) ?? 1,
        refresh: Boolean(refresh)
      }),
    { outputSchema: DashboardSchema }
  );

  registerReadOnlyTool(
    "learn_get_course_home",
    "Fetch and parse a course home page, including useful course navigation links and visible update text.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.getCourseHome(courseId as string),
    { outputSchema: CourseHomeSchema }
  );

  registerReadOnlyTool(
    "learn_list_content",
    "Fetch and parse the D2L Content page for a course.",
    {
      courseId: z.string().regex(/^\d+$/),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseId, refresh }) => learn.listContent(courseId as string, Boolean(refresh)),
    { outputSchema: ContentResultSchema }
  );

  registerReadOnlyTool(
    "learn_content",
    "Fetch and parse course content modules/topics for a course id.",
    {
      courseId: z.string().regex(/^\d+$/),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseId, refresh }) => learn.listContent(courseId as string, Boolean(refresh)),
    { outputSchema: ContentResultSchema }
  );

  registerReadOnlyTool(
    "learn_get_content_item",
    "Fetch and parse a specific D2L content item page, including embedded/downloadable file URLs.",
    {
      courseId: z.string().regex(/^\d+$/),
      contentId: z.string().regex(/^\d+$/)
    },
    async ({ courseId, contentId }) => learn.getContentItem(courseId as string, contentId as string),
    { outputSchema: ContentItemResultSchema }
  );

  registerReadOnlyTool(
    "learn_download_content_file",
    "Download an authenticated LEARN enforced content file URL into the local LEARN download directory.",
    {
      url: z.string().url(),
      filename: z.string().min(1).max(180).optional()
    },
    async ({ url, filename }) => learn.downloadContentFile(url as string, filename as string | undefined),
    { outputSchema: DownloadResultSchema }
  );

  registerReadOnlyTool(
    "learn_list_announcements",
    "Fetch visible announcement/news text and links from a course home page.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.listAnnouncements(courseId as string),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_list_grades",
    "Fetch and parse the read-only student grades page for a course.",
    {
      courseId: z.string().regex(/^\d+$/),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseId, refresh }) => learn.listGrades(courseId as string, Boolean(refresh)),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_grades",
    "Released grades, with each item's name, displayed grade, points and weight. Omit courseQuery to cover all courses. Items with no released grade are absent. This is the tool to answer 'how am I doing'.",
    {
      courseQuery: z.string().min(1).optional()
    },
    async ({ courseQuery }) => {
      const result = await service.grades(courseQuery as string | undefined);
      return { ...result, itemCount: result.items.length };
    },
    { requiresAuth: false, outputSchema: GradesResultSchema }
  );

  registerReadOnlyTool(
    "learn_list_calendar",
    "Fetch and parse the course calendar page.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.listCalendar(courseId as string),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_list_assignments",
    "Fetch and parse the course Dropbox/assignments page.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.listAssignments(courseId as string),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_list_quizzes",
    "Fetch and parse the course quizzes page.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.listQuizzes(courseId as string),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_list_discussions",
    "Fetch and parse the course discussions list page.",
    {
      courseId: z.string().regex(/^\d+$/)
    },
    async ({ courseId }) => learn.listDiscussions(courseId as string),
    { outputSchema: ParsedPageSchema }
  );

  registerReadOnlyTool(
    "learn_fetch_page",
    "Fetch and parse an arbitrary read-only page on learn.uwaterloo.ca. Only GET requests to the LEARN host are allowed.",
    {
      pathOrUrl: z.string().min(1)
    },
    async ({ pathOrUrl }) => learn.fetchPage(pathOrUrl as string),
    { outputSchema: ParsedPageSchema }
  );

  return { server, browser };
}

async function withToolTimeout<T>(operation: Promise<T> | T, toolName: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`LEARN_TIMEOUT: ${toolName} exceeded the 20 second tool deadline.`)),
          20_000
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyToolError(message: string) {
  if (/LEARN_TIMEOUT|timeout|timed out/i.test(message)) {
    return {
      ok: false,
      error: "LEARN_TIMEOUT",
      message,
      action: "Retry once. If the session expired, open the local auth page."
    };
  }
  if (/net::ERR_|connection reset|socket hang up|network/i.test(message)) {
    return { ok: false, error: "NETWORK_ERROR", message, action: "Retry the request." };
  }
  if (/\b(403|429)\b|rate limit|blocked/i.test(message)) {
    return { ok: false, error: "RATE_LIMIT_OR_BLOCKED", message, action: "Wait before retrying." };
  }
  if (/selector|layout|shadow root/i.test(message)) {
    return { ok: false, error: "UNKNOWN_LEARN_LAYOUT", message };
  }
  return { ok: false, error: "UNKNOWN_ERROR", message };
}
