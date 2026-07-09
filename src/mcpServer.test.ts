import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserSession } from "./browserSession.js";
import { LearnAuthError } from "./learnApi.js";
import { createLearnService } from "./learnService.js";
import { createLearnMcpServer } from "./mcpServer.js";
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

function fakeApi(overrides: { failAll?: Error } = {}) {
  const guard = async <T>(value: T): Promise<T> => {
    if (overrides.failAll) throw overrides.failAll;
    return value;
  };
  return {
    versions: async () => ({ le: "1.95", lp: "1.61" }),
    warmUp: async () => ({ le: "1.95", lp: "1.61" }),
    getJson: async () => ({}),
    courses: async () => guard(coursesPayload),
    assignments: async (ou: string | number) =>
      guard(String(ou) === "2002" ? [{ Id: 406030, Name: "Lab1.Post-lab.205", DueDate: day(2) }] : []),
    quizzes: async (ou: string | number) =>
      guard({ Objects: String(ou) === "2002" ? [{ QuizId: 9, Name: "Prelab4", DueDate: day(4), IsActive: true }] : [] }),
    grades: async (ou: string | number) =>
      guard(
        String(ou) === "2002"
          ? [
              {
                GradeObjectName: "Lab1.Post-lab.205",
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
    contentToc: async () => guard({ Modules: [] })
  } as never;
}

class FakeBrowser extends BrowserSession {
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
  options: { failAll?: Error } = {}
) {
  const service = createLearnService({ api: fakeApi(options), now: () => NOW });
  const { server } = createLearnMcpServer(new FakeBrowser(), { service });
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
    assert.deepEqual(content.items.map((i: any) => i.title), ["Lab1.Post-lab.205", "Prelab4"]);
    assert.deepEqual(content.items.map((i: any) => i.type), ["assignment", "quiz"]);
    assert.equal(content.items[0].courseLabel, "ECE 318");
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
    assert.deepEqual(content.items.map((i: any) => i.title), ["Lab1.Post-lab.205"]);
  });
});

test("learn_grades takes a course query, not an org unit id", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "learn_grades", arguments: { courseQuery: "ECE318" } });
    assert.equal(result.isError, undefined);

    const content = result.structuredContent as any;
    assert.equal(content.itemCount, 1);
    assert.equal(content.items[0].name, "Lab1.Post-lab.205");
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
