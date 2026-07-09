import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired } from "./authTypes.js";
import { BrowserSession } from "./browserSession.js";
import { LearnClient } from "./learnClient.js";
import { recordToolDoc, zodRawShapeToJson } from "./toolRegistry.js";
import {
  AnnouncementsResultSchema,
  AuthStatusSchema,
  ContentItemResultSchema,
  ContentResultSchema,
  CourseHomeSchema,
  CourseResolutionSchema,
  CoursesResultSchema,
  DashboardSchema,
  DownloadResultSchema,
  DueDatesSchema,
  ParsedPageSchema,
  schemaToJson
} from "./toolSchemas.js";

export interface LearnMcpServerHandle {
  server: McpServer;
  browser: BrowserSession;
}

export function createLearnMcpServer(browser = new BrowserSession()): LearnMcpServerHandle {
  const learn = new LearnClient(browser);

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
    "List current visible UW LEARN courses with id, name, code, and URL.",
    {
      pageSize: z.number().int().min(1).max(500).default(100).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ pageSize, includeRaw, refresh }) => learn.listCourses((pageSize as number | undefined) ?? 100, Boolean(refresh), Boolean(includeRaw)),
    { outputSchema: CoursesResultSchema }
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

  registerReadOnlyTool(
    "learn_due_items",
    "Aggregate upcoming due items across active courses or one resolved course. Important: read dueDateLines and items; checkedCourses/courses are only metadata. Default window is the next 14 days.",
    {
      courseQuery: z.string().min(1).optional(),
      daysAhead: z.number().int().min(1).max(180).default(14).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseQuery, daysAhead, includeRaw, refresh }) =>
      learn.dueDatesSummary({
        courseQuery: courseQuery as string | undefined,
        daysAhead: (daysAhead as number | undefined) ?? 14,
        includeRaw: Boolean(includeRaw),
        refresh: Boolean(refresh)
      }),
    { outputSchema: DueDatesSchema }
  );

  registerReadOnlyTool(
    "learn_due_dates",
    "Return upcoming readable due dates across active courses or one resolved course. Important: read the top-level items array; checkedCourses is only metadata. Default window is the next 14 days.",
    {
      courseQuery: z.string().min(1).optional(),
      daysAhead: z.number().int().min(1).max(180).default(14).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseQuery, daysAhead, includeRaw, refresh }) =>
      learn.dueDatesSummary({
        courseQuery: courseQuery as string | undefined,
        daysAhead: (daysAhead as number | undefined) ?? 14,
        includeRaw: Boolean(includeRaw),
        refresh: Boolean(refresh)
      }),
    { outputSchema: DueDatesSchema }
  );

  registerReadOnlyTool(
    "learn_latest_announcements",
    "Return the latest visible announcements for one resolved course query.",
    {
      courseQuery: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseQuery, limit, includeRaw, refresh }) =>
      learn.latestAnnouncements({
        courseQuery: courseQuery as string,
        limit: (limit as number | undefined) ?? 5,
        includeRaw: Boolean(includeRaw),
        refresh: Boolean(refresh)
      }),
    { outputSchema: AnnouncementsResultSchema }
  );

  registerReadOnlyTool(
    "learn_announcements",
    "Return recent visible announcements for one resolved course query.",
    {
      courseQuery: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5).optional(),
      includeRaw: z.boolean().default(false).optional(),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseQuery, limit, includeRaw, refresh }) =>
      learn.latestAnnouncements({
        courseQuery: courseQuery as string,
        limit: (limit as number | undefined) ?? 5,
        includeRaw: Boolean(includeRaw),
        refresh: Boolean(refresh)
      }),
    { outputSchema: AnnouncementsResultSchema }
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
    "Fetch and parse the visible student grades page for a course id.",
    {
      courseId: z.string().regex(/^\d+$/),
      refresh: z.boolean().default(false).optional()
    },
    async ({ courseId, refresh }) => learn.listGrades(courseId as string, Boolean(refresh)),
    { outputSchema: ParsedPageSchema }
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
