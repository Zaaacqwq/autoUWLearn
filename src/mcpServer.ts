import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired } from "./authTypes.js";
import { BrowserSession } from "./browserSession.js";
import { config, type Toolset } from "./config.js";
import { MissingSessionCookiesError } from "./cookieSource.js";
import {
  DownloadError,
  downloadFileName,
  MAX_DOWNLOAD_BYTES,
  refuseExisting,
  resolveDownloadDir,
  saveDownload
} from "./downloads.js";
import { createLearnApi, LearnAuthError, LearnFileTooLargeError } from "./learnApi.js";
import { createLearnService, type DownloadSource, type LearnService } from "./learnService.js";
import { createSessionCookieStore } from "./sessionCookies.js";
import { createSessionRecovery, type SessionRecovery } from "./sessionRecovery.js";
import { recordToolDoc, zodRawShapeToJson } from "./toolRegistry.js";
import {
  AnnouncementsFeedSchema,
  AssignmentResultSchema,
  AuthStatusSchema,
  ContentListingSchema,
  GradesResultSchema,
  LearnDownloadResultSchema,
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
  /** Injected by tests; otherwise a silent re-login through the browser profile. */
  recovery?: SessionRecovery;
  /** Injected by tests; otherwise LEARN_MCP_TOOLSET. */
  toolset?: Toolset;
  /** Injected by tests; otherwise LEARN_DOWNLOAD_ROOTS. */
  downloadRoots?: readonly string[];
}

/** A failed read is reported as it is; nothing is repaired underneath it. */
const noRecovery: SessionRecovery = { run: (operation) => operation() };

export function createLearnMcpServer(
  browser = new BrowserSession(),
  deps: LearnMcpServerDeps = {}
): LearnMcpServerHandle {
  const toolset = deps.toolset ?? config.toolset;
  const downloadRoots = deps.downloadRoots ?? config.downloadRoots;
  // Reads go straight to the Valence JSON API over the session cookies. The
  // browser is only needed to establish that session, never to serve a read.
  const cookies = createSessionCookieStore({
    liveCookies: () => browser.liveCookies(),
    storageStatePath: config.storageStatePath,
    host: new URL(config.learnBaseUrl).hostname
  });

  const service =
    deps.service ??
    createLearnService({
      api: createLearnApi({
        baseUrl: config.learnBaseUrl,
        cookieHeader: cookies.header,
        onSetCookie: cookies.absorb
      })
    });

  // A lapsed session is repaired under the failing read rather than reported,
  // whenever the browser profile can still complete SSO without a human.
  //
  // Except for agents. Their servers are short-lived and many: each one
  // launching Chromium on the one shared profile would fight over its lock, and
  // a server killed with its run would leave the browser holding it. The
  // long-running HTTP server's heartbeat re-logs in for everyone, and every
  // read takes the session from disk, so an agent picks that up on its next call.
  const recovery =
    deps.recovery ??
    (toolset === "agent" ? noRecovery : createSessionRecovery({ recover: () => browser.refreshSession() }));

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
    options: {
      recoversSession?: boolean;
      outputSchema?: z.ZodTypeAny;
      timeoutMs?: number;
      /** Still read-only toward LEARN, but creates files on this machine. */
      writesLocalFiles?: boolean;
      /** Opens a login window, saves or discards the session every client shares: not a read. */
      changesSession?: "opens" | "saves" | "discards";
    } = {}
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
          readOnlyHint: !options.writesLocalFiles && !options.changesSession,
          // Downloads only with overwrite: true, which the caller has to ask for;
          // a discarded session needs the user's SSO and MFA to get back.
          destructiveHint: Boolean(options.writesLocalFiles) || options.changesSession === "discards",
          idempotentHint: !options.writesLocalFiles && options.changesSession !== "opens",
          openWorldHint: true
        },
        securitySchemes: [{ type: "oauth2", scopes: ["learn.read"] }],
        ...(options.outputSchema ? { outputSchema: options.outputSchema, _meta: { outputJsonSchema: schemaToJson(options.outputSchema) } } : {})
      },
      async (input: Record<string, unknown>) => {
        try {
          // Reads retry through a silent re-login; the auth tools are what a
          // failed re-login falls back to, so they must report state as it is.
          const run = options.recoversSession === false
            ? () => Promise.resolve(handler(input))
            : () => recovery.run(async () => handler(input));
          return jsonResult(await withToolTimeout(run(), name, options.timeoutMs), {
            structured: Boolean(options.outputSchema)
          });
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
          if (error instanceof DownloadError) {
            return jsonResult(
              { ok: false, error: error.code, message: error.message, ...(error.action ? { action: error.action } : {}) },
              { isError: true }
            );
          }
          if (error instanceof LearnFileTooLargeError) {
            return jsonResult({ ok: false, error: "FILE_TOO_LARGE", message: error.message }, { isError: true });
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
    "Check whether the LEARN session is currently valid. Answers from the saved session without starting a browser, so it is safe to call before anything else.",
    {},
    async () => browser.sessionStatus(),
    { recoversSession: false, outputSchema: AuthStatusSchema }
  );

  // An agent can see whether the session works but cannot open a login window
  // nobody is watching, or throw away the session every other client shares.
  if (toolset === "all") {
    registerReadOnlyTool(
      "learn_auth_start",
      "Open Waterloo LEARN in the local browser so the user can complete SSO and MFA by hand, and return the local auth page URL. No Waterloo password is stored or sent to the model.",
      {},
      async () => browser.startManualLogin(),
      { recoversSession: false, outputSchema: AuthStatusSchema, timeoutMs: LOGIN_TOOL_TIMEOUT_MS, changesSession: "opens" }
    );

    registerReadOnlyTool(
      "learn_auth_save",
      "Persist the authenticated LEARN session so it survives the browser closing.",
      {},
      async () => browser.saveSessionState(),
      { recoversSession: false, outputSchema: AuthStatusSchema, changesSession: "saves" }
    );

    registerReadOnlyTool(
      "learn_auth_reset",
      "Discard the saved LEARN session. Use only when login state is broken; the user must log in again afterwards.",
      {},
      async () => browser.resetSession(),
      { recoversSession: false, outputSchema: AuthStatusSchema, timeoutMs: LOGIN_TOOL_TIMEOUT_MS, changesSession: "discards" }
    );
  }

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
    { outputSchema: MergedCoursesResultSchema }
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
    { outputSchema: UpcomingResultSchema }
  );

  registerReadOnlyTool(
    "learn_grades",
    "Released grades, with each item's name, displayed grade, points and weight. Omit courseQuery to cover all courses. Items whose grade has not been released are absent. Use this to answer 'how am I doing'.",
    { courseQuery: z.string().min(1).optional() },
    async ({ courseQuery }) => {
      const result = await service.grades(courseQuery as string | undefined);
      return { ...result, itemCount: result.items.length };
    },
    { outputSchema: GradesResultSchema }
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
    { outputSchema: AnnouncementsFeedSchema }
  );

  registerReadOnlyTool(
    "learn_content",
    "List a course's content: every lecture slide, lab handout and link, with the module it sits under. Returns titles and topicIds, not file contents. Use learn_read_content to read one.",
    { courseQuery: z.string().min(1).optional() },
    async ({ courseQuery }) => {
      const result = await service.content(courseQuery as string | undefined);
      return { ...result, itemCount: result.items.length };
    },
    { outputSchema: ContentListingSchema }
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
    { outputSchema: ReadTopicSchema }
  );

  registerReadOnlyTool(
    "learn_assignment",
    "One assignment (dropbox folder) in full: its instructions as text, its attachments (handouts, starter files) and links, its deadline, and whether it has been submitted. assignmentQuery matches a folder id exactly, or a substring of the title; returns candidates instead of guessing when several match. Use learn_download with the same assignmentQuery to fetch an attachment.",
    {
      assignmentQuery: z.string().min(1),
      courseQuery: z.string().min(1).optional()
    },
    async (input) =>
      service.assignment({
        assignmentQuery: input.assignmentQuery as string,
        courseQuery: input.courseQuery as string | undefined
      }),
    { outputSchema: AssignmentResultSchema }
  );

  registerReadOnlyTool(
    "learn_download",
    `Save one course file to a folder on this machine: a content file (topicQuery, matched like learn_read_content — starter code, handouts, slides) or an assignment attachment (assignmentQuery, plus fileId when it has several). destDir must be an absolute folder inside the server's allowed download roots; it is created if missing. An existing file is never replaced unless overwrite is true. Archives are saved as they are, not extracted. Files over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB are refused. Nothing is ever sent to LEARN.`,
    {
      destDir: z.string().min(1),
      courseQuery: z.string().min(1).optional(),
      topicQuery: z.string().min(1).optional(),
      assignmentQuery: z.string().min(1).optional(),
      fileId: z.string().min(1).optional(),
      overwrite: z.boolean().default(false).optional()
    },
    async (input) => {
      const topicQuery = input.topicQuery as string | undefined;
      const assignmentQuery = input.assignmentQuery as string | undefined;
      const fileId = input.fileId as string | undefined;
      const overwrite = input.overwrite === true;
      if (Boolean(topicQuery) === Boolean(assignmentQuery)) {
        throw new DownloadError("INVALID_ARGUMENTS", "Pass exactly one of topicQuery or assignmentQuery.");
      }
      if (fileId && !assignmentQuery) {
        throw new DownloadError("INVALID_ARGUMENTS", "fileId picks an assignment attachment; pass assignmentQuery with it.");
      }

      // Refuse a write before asking LEARN for anything.
      const dir = await resolveDownloadDir(downloadRoots, input.destDir as string);
      const located = await service.locateDownload({
        courseQuery: input.courseQuery as string | undefined,
        topicQuery,
        assignmentQuery,
        fileId
      });
      if (located.status !== "ok" || !located.source) return located;

      const name = downloadFileName(located.source.fileName);
      await refuseExisting(path.join(dir, name), overwrite);
      const file = await service.fetchDownload(located.source, { maxBytes: MAX_DOWNLOAD_BYTES });
      const written = await saveDownload(dir, name, file.bytes, { overwrite });

      return {
        status: "ok",
        query: located.query,
        path: written,
        bytes: file.bytes.byteLength,
        contentType: file.contentType,
        source: describeSource(located.source)
      };
    },
    { outputSchema: LearnDownloadResultSchema, timeoutMs: DOWNLOAD_TOOL_TIMEOUT_MS, writesLocalFiles: true }
  );

  return { server, browser };
}

function describeSource(source: DownloadSource) {
  if (source.kind === "topic") {
    return { kind: "topic" as const, id: source.topic.topicId, title: source.topic.title, courseLabel: source.topic.courseLabel };
  }
  return {
    kind: "attachment" as const,
    id: source.attachment.fileId,
    title: source.attachment.name,
    courseLabel: source.assignment.courseLabel,
    assignmentId: source.assignment.id
  };
}

/** Reads answer from the API and must stay snappy. */
const DEFAULT_TOOL_TIMEOUT_MS = 20_000;

/**
 * Starting a login is the one tool that legitimately takes its time: it launches
 * a browser and walks into Waterloo's SSO. Holding it to the deadline meant for
 * an API read reported a timeout for work that was proceeding normally.
 */
const LOGIN_TOOL_TIMEOUT_MS = 90_000;

/** A large starter archive over a slow link; a read's 20 seconds would cut it off. */
const DOWNLOAD_TOOL_TIMEOUT_MS = 120_000;

async function withToolTimeout<T>(
  operation: Promise<T> | T,
  toolName: string,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `LEARN_TIMEOUT: ${toolName} exceeded the ${Math.round(timeoutMs / 1000)} second tool deadline.`
              )
            ),
          timeoutMs
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
