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
  ContentListingSchema,
  GradesResultSchema,
  MergedCoursesResultSchema,
  ReadTopicSchema,
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

  /* Auth. The browser exists only to establish a LEARN session; no read uses it. */

  registerReadOnlyTool(
    "learn_auth_status",
    "Check whether the LEARN session is currently valid.",
    {},
    async () => learn.authStatus(true),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_start",
    "Open Waterloo LEARN in the local browser so the user can complete SSO and MFA by hand, and return the local auth page URL. No Waterloo password is stored or sent to the model.",
    {},
    async () => learn.authStart(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_save",
    "Persist the authenticated LEARN session so it survives the browser closing.",
    {},
    async () => learn.authSave(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  registerReadOnlyTool(
    "learn_auth_reset",
    "Discard the saved LEARN session. Use only when login state is broken; the user must log in again afterwards.",
    {},
    async () => learn.authReset(),
    { requiresAuth: false, outputSchema: AuthStatusSchema }
  );

  /* Reads, served from the Valence JSON API. Each takes an optional courseQuery
     such as "ECE 318"; omitting it covers every course. */

  registerReadOnlyTool(
    "learn_courses",
    "List the user's current LEARN courses. Each course merges its org units (lecture, lab, sections) under one label such as 'ECE 318'. Pass that label to the other tools; never pass an orgUnitId.",
    {},
    async () => {
      const courses = await service.courses();
      return { count: courses.length, courses };
    },
    { requiresAuth: false, outputSchema: MergedCoursesResultSchema }
  );

  registerReadOnlyTool(
    "learn_due_dates",
    "Everything due in the next N days, across all courses at once: assignments, quizzes, and content modules that carry a deadline. Each item reports submissionStatus, so answer 'did I submit this?' from that field and never infer it from whether a grade exists — a submitted but ungraded item has no grade. Prefer dueAtLocal when speaking to the user; dueAt is UTC. Omit courseQuery to cover all courses.",
    {
      courseQuery: z.string().min(1).optional(),
      daysAhead: z.number().int().min(1).max(180).default(14).optional()
    },
    async (input) => {
      const daysAhead = (input.daysAhead as number | undefined) ?? 14;
      const result = await service.upcoming({
        courseQuery: input.courseQuery as string | undefined,
        daysAhead
      });
      return { ...result, daysAhead, itemCount: result.items.length };
    },
    { requiresAuth: false, outputSchema: UpcomingResultSchema }
  );

  registerReadOnlyTool(
    "learn_grades",
    "Released grades, with each item's name, displayed grade, points and weight. Omit courseQuery to cover all courses. Items whose grade has not been released are absent. Use this to answer 'how am I doing'.",
    { courseQuery: z.string().min(1).optional() },
    async ({ courseQuery }) => {
      const result = await service.grades(courseQuery as string | undefined);
      return { ...result, itemCount: result.items.length };
    },
    { requiresAuth: false, outputSchema: GradesResultSchema }
  );

  registerReadOnlyTool(
    "learn_announcements",
    "Recent announcements, newest first, with their full text. Omit courseQuery to cover all courses. Use this to answer 'what is the latest announcement'.",
    {
      courseQuery: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).default(10).optional()
    },
    async (input) => {
      const result = await service.announcements({
        courseQuery: input.courseQuery as string | undefined,
        limit: (input.limit as number | undefined) ?? 10
      });
      return { ...result, itemCount: result.items.length };
    },
    { requiresAuth: false, outputSchema: AnnouncementsFeedSchema }
  );

  registerReadOnlyTool(
    "learn_content",
    "List a course's content: every lecture slide, lab handout and link, with the module it sits under. Returns titles and topicIds, not file contents. Use learn_read_content to read one.",
    { courseQuery: z.string().min(1).optional() },
    async ({ courseQuery }) => {
      const result = await service.content(courseQuery as string | undefined);
      return { ...result, itemCount: result.items.length };
    },
    { requiresAuth: false, outputSchema: ContentListingSchema }
  );

  registerReadOnlyTool(
    "learn_read_content",
    "Read the text of one course file, such as a lecture PDF. topicQuery matches a topicId exactly, or a substring of the title. Returns candidates instead of guessing when several match. Use this to answer questions about what a lecture says.",
    {
      topicQuery: z.string().min(1),
      courseQuery: z.string().min(1).optional(),
      maxChars: z.number().int().min(1000).max(200_000).default(40_000).optional()
    },
    async (input) =>
      service.readTopic({
        topicQuery: input.topicQuery as string,
        courseQuery: input.courseQuery as string | undefined,
        maxChars: input.maxChars as number | undefined
      }),
    { requiresAuth: false, outputSchema: ReadTopicSchema }
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
