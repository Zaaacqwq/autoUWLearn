/**
 * Live smoke test for the content tools.
 *
 *   npx tsx scripts/smoke-learn-content.ts [courseQuery] [topicQuery]
 *
 * Read-only. Lists a course's files and reads one, printing only a short
 * excerpt so lecture material is not dumped into a terminal log.
 */
import os from "node:os";
import path from "node:path";
import { cookieHeaderFromStorageState } from "../src/cookieSource.js";
import { createLearnApi } from "../src/learnApi.js";
import { createLearnService } from "../src/learnService.js";

const courseQuery = process.argv[2] ?? "ECE 327";
const topicQuery = process.argv[3] ?? "introduction";

const storageState =
  process.env.LEARN_STORAGE_STATE_PATH ?? path.resolve(os.homedir(), ".uwlearn-mcp", "storage-state.json");

const service = createLearnService({
  api: createLearnApi({
    cookieHeader: () => cookieHeaderFromStorageState(storageState, "learn.uwaterloo.ca")
  })
});

const listing = await service.content(courseQuery);
console.log(`=== ${courseQuery}: ${listing.items.length} topics (${listing.items.filter((t) => t.isFile).length} downloadable files) ===`);
for (const topic of listing.items.slice(0, 8)) {
  const kind = topic.isFile ? (topic.extension ?? "file") : topic.type.toLowerCase();
  console.log(`   [${kind.padEnd(5)}] ${topic.modulePath.join(" / ").padEnd(24)} ${topic.title}`);
}
if (listing.items.length > 8) console.log(`   ... and ${listing.items.length - 8} more`);

const started = Date.now();
const read = await service.readTopic({ courseQuery, topicQuery });
console.log(`\n=== readTopic(${JSON.stringify(topicQuery)}) -> ${read.status} (${Date.now() - started}ms) ===`);

if (read.status === "ambiguous") {
  console.log("candidates:");
  for (const c of read.candidates ?? []) console.log(`   ${c.topicId}  ${c.title}`);
} else if (read.status === "ok") {
  console.log(`title:  ${read.topic?.title}`);
  console.log(`pages:  ${read.pages}`);
  console.log(`bytes:  ${read.bytes}`);
  console.log(`chars:  ${read.text?.length}${read.truncated ? " (truncated)" : ""}`);
  console.log(`\n--- first 300 chars ---\n${read.text?.slice(0, 300)}`);
}
