/**
 * Live smoke test for the service layer that backs the MCP tools.
 *
 *   npx tsx scripts/smoke-learn-service.ts
 *
 * Read-only. Prints due dates and announcement titles; grades are summarised as
 * counts only, never as values.
 */
import os from "node:os";
import path from "node:path";
import { cookieHeaderFromStorageState } from "../src/cookieSource.js";
import { createLearnApi } from "../src/learnApi.js";
import { createLearnService } from "../src/learnService.js";

const storageState =
  process.env.LEARN_STORAGE_STATE_PATH ?? path.resolve(os.homedir(), ".uwlearn-mcp", "storage-state.json");

const service = createLearnService({
  api: createLearnApi({
    cookieHeader: () => cookieHeaderFromStorageState(storageState, "learn.uwaterloo.ca")
  })
});

const toronto = (iso: string) =>
  new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });

const started = Date.now();
const courses = await service.courses();
console.log(`=== ${courses.length} courses (merged from ${courses.reduce((n, c) => n + c.orgUnitIds.length, 0)} org units) ===`);
for (const course of courses) {
  console.log(`   ${course.label.padEnd(12)} ${course.orgUnitIds.length} component(s): ${course.components.map((c) => c.name).join(" | ")}`);
}

const upcoming = await service.upcoming({ daysAhead: 14 });
console.log(`\n=== due in the next 14 days: ${upcoming.items.length} ===`);
for (const item of upcoming.items) {
  console.log(`   ${toronto(item.dueAt).padEnd(22)} ${item.courseLabel.padEnd(10)} ${item.type.padEnd(10)} ${item.title}`);
}
if (upcoming.errors.length) {
  console.log(`   errors: ${upcoming.errors.map((e) => `${e.courseLabel}/${e.source}: ${e.error}`).join("; ")}`);
}

const grades = await service.grades();
console.log(`\n=== released grades: ${grades.items.length} items ===`);
for (const course of courses) {
  const n = grades.items.filter((g) => g.courseKey === course.key).length;
  if (n) console.log(`   ${course.label.padEnd(12)} ${n} released`);
}

const news = await service.announcements({ limit: 5 });
console.log(`\n=== latest announcements ===`);
for (const item of news.items) {
  console.log(`   ${(item.postedAt ? toronto(item.postedAt) : "undated").padEnd(22)} ${item.courseLabel.padEnd(10)} ${item.title}`);
}

console.log(`\ntotal ${Date.now() - started}ms`);
