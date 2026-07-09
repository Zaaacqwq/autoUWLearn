/**
 * Asks the built stdio server, over the real MCP protocol, which tools it
 * advertises. This is what a client sees; /tools.json is only our own docs.
 *
 *   npx tsx scripts/list-tools.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.js"],
  env: { ...process.env, LEARN_HEADLESS: "true" }
});

const client = new Client({ name: "list-tools", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list advertises ${tools.length} tools:\n`);
for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
  const args = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
  console.log(`  ${tool.name.padEnd(22)} (${args.join(", ") || "-"})`);
}

const removed = ["learn_due_items", "learn_course_dashboard", "learn_all_courses_dashboard", "learn_list_calendar", "learn_list_assignments"];
const stillThere = removed.filter((name) => tools.some((t) => t.name === name));
console.log(`\nremoved-in-phase-4 tools still advertised: ${stillThere.length ? stillThere.join(", ") : "none"}`);

await client.close();
