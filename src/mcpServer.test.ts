import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserSession } from "./browserSession.js";
import { LearnAuthError } from "./learnApi.js";
import { createLearnService } from "./learnService.js";
import { createLearnMcpServer } from "./mcpServer.js";
import { createSessionRecovery } from "./sessionRecovery.js";
import type { AuthStatus } from "./authTypes.js";

const NOW = Date.parse("2026-07-09T00:00:00.000Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

/** Two org units of one course (lecture + lab), as LEARN really reports them. */
const coursesPayload = {
  Courses: [
    { OrgUnitId: "2001", Code: "ECE318_lect_002_1265", Name: "ECE 318 (002) - Spring 2026", IsActive: true },
    { OrgUnitId: "2002", Code: "ECE318_lab_1265", Name: "ECE 318 Lab - Spring 2026", IsActive: true },
    { OrgUnitId: "2003", Code: "ECE350_lect_1265", Name: "ECE 350 - Spring 2026", IsActive: true }
  ]
};

function fakeApi(overrides: { readonly failAll?: Error } = {}) {
  const guard = async <T>(value: T): Promise<T> => {
    // Read once: a caller may supply a failure that fires only on the first look.
    const failure = overrides.failAll;
    if (failure) throw failure;
    return value;
  };
  return {
    versions: async () => ({ le: "1.95", lp: "1.61" }),
    warmUp: async () => ({ le: "1.95", lp: "1.61" }),
    getJson: async () => ({}),
    courses: async () => guard(coursesPayload),
    calendarEvents: async (ou: string | number) =>
      guard(
        String(ou) === "2002"
          ? [
              {
                CalendarEventId: 1,
                Title: "Lab1.Post-lab",
                EventType: 6,
                StartDateTime: day(2),
                EndDateTime: day(2),
                AssociatedEntity: { AssociatedEntityType: "D2L.LE.Dropbox.Dropbox", AssociatedEntityId: 4001 }
              },
              {
                CalendarEventId: 2,
                Title: "Prelab4",
                EventType: 6,
                StartDateTime: day(4),
                EndDateTime: day(4),
                AssociatedEntity: { AssociatedEntityType: "D2L.LE.Quizzing.Quiz", AssociatedEntityId: 9 }
              }
            ]
          : []
      ),
    fetchHtml: async (path: string) =>
      guard(
        /quizzing/.test(path)
          ? '<table><tr><td><a href="javascript://">Prelab4</a></td><td></td><td>0 / 1</td></tr></table>'
          : '<table><tr><th>Lab1.Post-lab</th><td><a href="/x?db=4001">1 Submission, 1 File</a></td><td>-</td><td></td></tr></table>'
      ),
    // No due date, so it stays out of learn_due_dates' window.
    assignments: async (ou: string | number) =>
      guard(
        String(ou) === "2002"
          ? [
              {
                Id: 4001,
                Name: "Lab1.Post-lab",
                DueDate: null,
                CustomInstructions: { Text: "", Html: "<p>Submit the report.</p>" },
                Attachments: [{ FileId: 51, FileName: "template.docx", Size: 3 }]
              }
            ]
          : []
      ),
    quizzes: async () => guard({ Objects: [] }),
    grades: async (ou: string | number) =>
      guard(
        String(ou) === "2002"
          ? [
              {
                GradeObjectName: "Lab1.Post-lab",
                DisplayedGrade: "77 %",
                PointsNumerator: 77,
                PointsDenominator: 100,
                WeightedNumerator: 7.7,
                WeightedDenominator: 10
              }
            ]
          : []
      ),
    announcements: async (ou: string | number) =>
      guard(
        String(ou) === "2001"
          ? [{ Id: 1, Title: "Prelab 4 office hour", Body: { Text: "Room E5" }, StartDate: day(-1) }]
          : []
      ),
    contentToc: async (ou: string | number) =>
      guard(
        String(ou) === "2005" || String(ou) === "2001"
          ? {
              Modules: [
                {
                  ModuleId: 1,
                  Title: "Lectures",
                  Topics: [
                    {
                      TopicId: 3001,
                      Title: "01-introduction",
                      TypeIdentifier: "File",
                      Url: "/content/enforced/2001-ECE318/01-introduction.pdf"
                    }
                  ]
                }
              ]
            }
          : { Modules: [] }
      ),
    fetchFile: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf", url: "x" }),
    fetchAttachment: async () => ({ bytes: new Uint8Array([7, 7, 7]), contentType: "application/octet-stream", url: "x" })
  } as never;
}

class FakeBrowser extends BrowserSession {
  override async sessionStatus(): Promise<AuthStatus> {
    return this.authStatus();
  }
  override async refreshSession(): Promise<boolean> {
    return true;
  }
  override async authStatus(): Promise<AuthStatus> {
    return {
      ok: true,
      authenticated: true,
      state: "LOGGED_IN",
      url: "https://learn.uwaterloo.ca/d2l/home",
      title: "LEARN",
      message: "UW LEARN session is active.",
      authUrl: "http://127.0.0.1:8787/auth"
    };
  }
  override async liveCookies() {
    return null;
  }
  override async close(): Promise<void> {}
}

async function withClient(
  run: (client: Client) => Promise<void>,
  options: {
    failAll?: Error;
    failOnce?: Error;
    recover?: () => Promise<boolean>;
    toolset?: "all" | "agent";
    downloadRoots?: string[];
    browser?: BrowserSession;
  } = {}
) {
  // failOnce reproduces the real shape of a lapse: the first read fails, and a
  // silent re-login is all that stands between the user and an answer.
  let pending = options.failOnce;
  const api = fakeApi({
    get failAll() {
      if (options.failAll) return options.failAll;
      const once = pending;
      pending = undefined;
      return once;
    }
  });
  const service = createLearnService({ api, now: () => NOW });
  const { server } = createLearnMcpServer(options.browser ?? new FakeBrowser(), {
    service,
    toolset: options.toolset ?? "all",
    downloadRoots: options.downloadRoots ?? [],
    ...(options.recover ? { recovery: createSessionRecovery({ recover: options.recover }) } : {})
  });
  const client = new Client({ name: "autouwlearn-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("learn_courses merges a course's org units under one label", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_courses", arguments: {} });
    assert.equal(result.isError, undefined);

    const { courses, count } = result.structuredContent as any;
    assert.equal(count, 2, "three org units, two courses");

    const ece318 = courses.find((c: any) => c.key === "ECE318");
    assert.equal(ece318.label, "ECE 318");
    assert.equal(ece318.orgUnitIds.length, 2, "lecture and lab are one course");
  });
});

test("learn_due_dates answers 'what is due this week' without disambiguation", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_due_dates", arguments: { daysAhead: 7 } });
    assert.equal(result.isError, undefined);

    const content = result.structuredContent as any;
    assert.equal(content.status, "ok");
    assert.deepEqual(content.items.map((i: any) => i.title), ["Lab1.Post-lab", "Prelab4"]);
    assert.deepEqual(content.items.map((i: any) => i.type), ["assignment", "quiz"]);
    assert.equal(content.items[0].courseLabel, "ECE 318");
  });
});

test("learn_due_dates reports submission status, so a model need not infer it from grades", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_due_dates", arguments: { daysAhead: 7 } });
    const content = result.structuredContent as any;

    const assignment = content.items.find((i: any) => i.title === "Lab1.Post-lab");
    const quiz = content.items.find((i: any) => i.title === "Prelab4");
    assert.equal(assignment.submissionStatus, "submitted");
    assert.equal(quiz.submissionStatus, "not_submitted");
    assert.ok(assignment.dueAtLocal, "a local rendering is present alongside the UTC instant");
  });
});

test("a course query that used to be ambiguous now resolves to one course", async () => {
  // The lecture and lab org units previously produced status "ambiguous" and
  // pushed the choice onto the model.
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "learn_due_dates",
      arguments: { courseQuery: "ECE 318", daysAhead: 7 }
    });
    const content = result.structuredContent as any;
    assert.equal(content.status, "ok");
    assert.equal(content.courses.length, 1);
    assert.equal(content.items.length, 2);
  });
});

test("learn_due_dates honours the daysAhead window", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_due_dates", arguments: { daysAhead: 3 } });
    const content = result.structuredContent as any;
    assert.deepEqual(content.items.map((i: any) => i.title), ["Lab1.Post-lab"]);
  });
});

test("learn_grades takes a course query, not an org unit id", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_grades", arguments: { courseQuery: "ECE318" } });
    assert.equal(result.isError, undefined);

    const content = result.structuredContent as any;
    assert.equal(content.itemCount, 1);
    assert.equal(content.items[0].name, "Lab1.Post-lab");
    assert.equal(content.items[0].displayedGrade, "77 %");
    assert.deepEqual(content.items[0].points, { earned: 77, possible: 100 });
  });
});

test("learn_announcements returns the body text, newest first", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_announcements", arguments: {} });
    const content = result.structuredContent as any;
    assert.equal(content.items[0].title, "Prelab 4 office hour");
    assert.equal(content.items[0].body, "Room E5");
    assert.equal(content.items[0].courseLabel, "ECE 318");
  });
});

test("an unknown course reports not_found rather than silently answering for everything", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "learn_due_dates",
      arguments: { courseQuery: "MATH 999" }
    });
    const content = result.structuredContent as any;
    assert.equal(content.status, "not_found");
    assert.equal(content.items.length, 0);
  });
});

test("an expired session is reported as an auth error with the login URL", async () => {
  await withClient(
    async (client) => {
      const result = await client.callTool({ name: "learn_due_dates", arguments: {} });
      assert.equal(result.isError, true);

      const payload = JSON.parse((result.content as any)[0].text);
      assert.equal(payload.error, "AUTH_REQUIRED");
      assert.match(payload.authUrl, /\/auth$/);
    },
    { failAll: new LearnAuthError("/d2l/api/le/1.95/1/grades/") }
  );
});

test("a session that lapses mid-read is repaired silently, not handed to the user", async () => {
  let recoveries = 0;
  await withClient(
    async (client) => {
      const result = await client.callTool({ name: "learn_due_dates", arguments: {} });

      assert.equal(result.isError, undefined, "the user should never learn this happened");
      assert.equal((result.structuredContent as any).itemCount > 0, true);
    },
    {
      failOnce: new LearnAuthError("/d2l/api/le/1.95/1/grades/"),
      recover: async () => {
        recoveries += 1;
        return true;
      }
    }
  );
  assert.equal(recoveries, 1);
});

test("only when a re-login cannot help is the user sent to the login page", async () => {
  await withClient(
    async (client) => {
      const result = await client.callTool({ name: "learn_due_dates", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse((result.content as any)[0].text).error, "AUTH_REQUIRED");
    },
    { failAll: new LearnAuthError("/d2l/api/le/1.95/1/grades/"), recover: async () => false }
  );
});

test("learn_auth_status reports the session as it is, without repairing it first", async () => {
  // It is the fallback a failed recovery points at; a self-healing answer here
  // would tell the user they are logged in while every read still fails.
  let recoveries = 0;
  await withClient(
    async (client) => {
      const result = await client.callTool({ name: "learn_auth_status", arguments: {} });
      assert.equal(result.isError, undefined);
    },
    {
      recover: async () => {
        recoveries += 1;
        return true;
      }
    }
  );
  assert.equal(recoveries, 0);
});

test("learn_content lists a course's files with their module path", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_content", arguments: { courseQuery: "ECE 318" } });
    assert.equal(result.isError, undefined);

    const content = result.structuredContent as any;
    assert.equal(content.itemCount, 1);
    assert.equal(content.items[0].title, "01-introduction");
    assert.deepEqual(content.items[0].modulePath, ["Lectures"]);
    assert.equal(content.items[0].isFile, true);
    assert.equal(content.items[0].extension, "pdf");
    assert.equal(content.items[0].courseLabel, "ECE 318");
  });
});

test("learn_read_content reports not_found for a topic that does not exist", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "learn_read_content",
      arguments: { topicQuery: "nonexistent lecture", courseQuery: "ECE 318" }
    });
    assert.equal((result.structuredContent as any).status, "not_found");
  });
});

test("registering the tools populates the doc registry that /tools.json serves", async () => {
  // httpServer.ts registers the tools at module scope purely for this side
  // effect. It looks like dead code; deleting it empties /tools.json and
  // /openapi.json until an MCP session happens to connect.
  const { getToolDocs } = await import("./toolRegistry.js");
  const service = createLearnService({ api: fakeApi(), now: () => NOW });
  createLearnMcpServer(new FakeBrowser(), { service });

  const names = getToolDocs().map((doc) => doc.name);
  assert.ok(names.includes("learn_due_dates"), "learn_due_dates should be documented");
  assert.ok(names.includes("learn_read_content"));
  assert.ok(names.includes("learn_assignment"));
  assert.ok(names.includes("learn_download"));
  assert.ok(getToolDocs().every((doc) => doc.inputSchema), "every tool documents its input");
});

test("the agent toolset leaves out the login tools and keeps reads and downloads", async () => {
  await withClient(
    async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["learn_auth_start", "learn_auth_save", "learn_auth_reset"]) {
        assert.ok(!names.includes(name), `${name} is not an agent's to call`);
      }
      for (const name of ["learn_auth_status", "learn_due_dates", "learn_read_content", "learn_assignment", "learn_download"]) {
        assert.ok(names.includes(name), `${name} is available`);
      }
    },
    { toolset: "agent" }
  );
});

test("an agent's server reports a lapsed session instead of starting a browser", async () => {
  // Many short-lived agent servers share one browser profile; recovery is the
  // long-running server's job.
  class CountingBrowser extends FakeBrowser {
    refreshes = 0;
    override async refreshSession(): Promise<boolean> {
      this.refreshes += 1;
      return true;
    }
  }
  const browser = new CountingBrowser();
  await withClient(
    async (client) => {
      const result = await client.callTool({ name: "learn_due_dates", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse((result.content as any)[0].text).error, "AUTH_REQUIRED");
    },
    { toolset: "agent", browser, failAll: new LearnAuthError("/d2l/api/le/1.95/1/grades/") }
  );
  assert.equal(browser.refreshes, 0);
});

test("learn_assignment returns an assignment's instructions, attachments and status", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "learn_assignment",
      arguments: { assignmentQuery: "post-lab", courseQuery: "ECE 318" }
    });
    assert.equal(result.isError, undefined);

    const { status, assignment } = result.structuredContent as any;
    assert.equal(status, "ok");
    assert.equal(assignment.instructions, "Submit the report.");
    assert.deepEqual(assignment.attachments, [{ fileId: "51", name: "template.docx", size: 3 }]);
    assert.equal(assignment.submissionStatus, "submitted");
    assert.equal(assignment.dueAt, null);
  });
});

/** A download root in the temp dir, by its real path (/tmp is a link on macOS). */
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autouwlearn-mcp-dl-")));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const errorOf = (result: any) => JSON.parse(result.content[0].text).error;

test("learn_download saves a course file into the folder asked for", async () => {
  await withRoot(async (root) => {
    await withClient(
      async (client) => {
        const destDir = path.join(root, "lectures");
        const result = await client.callTool({
          name: "learn_download",
          arguments: { courseQuery: "ECE 318", topicQuery: "introduction", destDir }
        });
        assert.equal(result.isError, undefined);

        const content = result.structuredContent as any;
        assert.equal(content.path, path.join(destDir, "01-introduction.pdf"));
        assert.equal(content.bytes, 1);
        assert.deepEqual(content.source, { kind: "topic", id: "3001", title: "01-introduction", courseLabel: "ECE 318" });
        assert.deepEqual([...(await fs.readFile(content.path))], [1]);

        const again = await client.callTool({
          name: "learn_download",
          arguments: { courseQuery: "ECE 318", topicQuery: "introduction", destDir }
        });
        assert.equal(again.isError, true);
        assert.equal(errorOf(again), "FILE_EXISTS");

        const replaced = await client.callTool({
          name: "learn_download",
          arguments: { courseQuery: "ECE 318", topicQuery: "introduction", destDir, overwrite: true }
        });
        assert.equal(replaced.isError, undefined);
      },
      { downloadRoots: [root] }
    );
  });
});

test("learn_download saves an assignment attachment", async () => {
  await withRoot(async (root) => {
    await withClient(
      async (client) => {
        const result = await client.callTool({
          name: "learn_download",
          arguments: { assignmentQuery: "post-lab", destDir: root }
        });
        const content = result.structuredContent as any;
        assert.equal(content.path, path.join(root, "template.docx"));
        assert.equal(content.source.kind, "attachment");
        assert.equal(content.source.assignmentId, "4001");
        assert.deepEqual([...(await fs.readFile(content.path))], [7, 7, 7]);
      },
      { downloadRoots: [root] }
    );
  });
});

test("learn_download refuses a folder outside its roots, and is off without any", async () => {
  await withRoot(async (root) => {
    await withClient(
      async (client) => {
        const result = await client.callTool({
          name: "learn_download",
          arguments: { topicQuery: "introduction", destDir: path.dirname(root) }
        });
        assert.equal(result.isError, true);
        assert.equal(errorOf(result), "OUTSIDE_DOWNLOAD_ROOTS");
      },
      { downloadRoots: [root] }
    );
  });

  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_download", arguments: { topicQuery: "introduction", destDir: "/tmp" } });
    assert.equal(errorOf(result), "DOWNLOADS_DISABLED");
  });
});

test("learn_download wants exactly one of a topic and an assignment", async () => {
  await withRoot(async (root) => {
    await withClient(
      async (client) => {
        for (const args of [{}, { topicQuery: "a", assignmentQuery: "b" }, { topicQuery: "a", fileId: "1" }]) {
          const result = await client.callTool({ name: "learn_download", arguments: { ...args, destDir: root } });
          assert.equal(errorOf(result), "INVALID_ARGUMENTS", JSON.stringify(args));
        }
      },
      { downloadRoots: [root] }
    );
  });
});
