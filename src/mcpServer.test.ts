import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserSession } from "./browserSession.js";
import { createLearnMcpServer } from "./mcpServer.js";
import type { AuthStatus } from "./authTypes.js";
import type { FetchTextResult, RenderedPageResult } from "./types.js";

const coursesJson = {
  Items: [
    { OrgUnitId: 2003, Name: "ECE 350 - Spring 2026", Code: "ECE350_A", IsActive: true },
    { OrgUnitId: 1269346, Name: "ECE 350 - Spring 2026", Code: "ECE350_B", IsActive: true }
  ]
};

const announcementsHtml = `<!doctype html><html><head><title>Announcements</title></head><body>
  <table><thead><tr><th>Title</th><th>Start Date</th></tr></thead><tbody>
    <tr><td><a href="/d2l/le/news/2003/1118211/view?ou=2003">Optional lab demo</a></td><td>Jun 10, 2026 9:12 AM</td></tr>
  </tbody></table>
</body></html>`;

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

  override async fetchText(url: string): Promise<FetchTextResult> {
    const isCourses = url.includes("/manageCourses/api/mycourses");
    return {
      url,
      status: 200,
      ok: true,
      contentType: isCourses ? "application/json" : "text/html",
      text: isCourses ? JSON.stringify(coursesJson) : announcementsHtml
    };
  }

  override async fetchRendered(url: string): Promise<RenderedPageResult> {
    return {
      url,
      status: 200,
      ok: true,
      contentType: "text/html",
      text: "",
      title: "Optional lab demo - ECE 350",
      renderedText: "Optional lab demo",
      shadowBlocks: [
        {
          text: "Hi everyone,\nThe optional lab demos are being conducted this week.",
          links: [{ label: "RSVP", url: "https://example.com/rsvp" }]
        }
      ]
    };
  }

  override async close(): Promise<void> {}
}

async function withClient(run: (client: Client) => Promise<void>) {
  const { server } = createLearnMcpServer(new FakeBrowser());
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

test("announcement tools return schema-valid structured content with a rendered body", async () => {
  await withClient(async (client) => {
    const latest = await client.callTool({
      name: "learn_latest_announcements",
      arguments: { courseQuery: "ECE350_A", limit: 1, refresh: true }
    });
    assert.equal(latest.isError, undefined);
    const latestContent = latest.structuredContent as any;
    assert.equal(latestContent.announcements[0].title, "Optional lab demo");
    assert.match(latestContent.announcements[0].body, /conducted this week/);
    assert.equal(latestContent.announcements[0].contentStatus, "full");

    const listed = await client.callTool({
      name: "learn_list_announcements",
      arguments: { courseId: "2003" }
    });
    assert.equal(listed.isError, undefined);
    assert.equal((listed.structuredContent as any).title, "Announcements");
  });
});

test("course and ambiguous due-date results pass MCP output validation without raw payloads", async () => {
  await withClient(async (client) => {
    const courses = await client.callTool({ name: "learn_courses", arguments: { refresh: true } });
    const coursesContent = courses.structuredContent as any;
    assert.equal(coursesContent.raw, undefined);
    assert.equal(coursesContent.courses[0].raw, undefined);

    const due = await client.callTool({
      name: "learn_due_dates",
      arguments: { courseQuery: "ECE 350", refresh: true }
    });
    assert.equal(due.isError, undefined);
    assert.equal((due.structuredContent as any).status, "ambiguous");
    assert.equal((due.structuredContent as any).matches.length, 2);
  });
});
