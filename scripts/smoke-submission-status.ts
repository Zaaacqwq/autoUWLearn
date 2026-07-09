/**
 * Validates the submission-status parsers against the live LEARN pages.
 *
 *   npx tsx scripts/smoke-submission-status.ts
 *
 * Read-only. Prints names and submission state, never scores.
 */
import os from "node:os";
import path from "node:path";
import { cookieHeaderFromStorageState } from "../src/cookieSource.js";
import { parseDropboxList, parseQuizList } from "../src/submissionStatus.js";

const BASE = process.env.LEARN_BASE_URL ?? "https://learn.uwaterloo.ca";
const storageState =
  process.env.LEARN_STORAGE_STATE_PATH ?? path.resolve(os.homedir(), ".uwlearn-mcp", "storage-state.json");
const cookie = cookieHeaderFromStorageState(storageState, new URL(BASE).hostname);

const html = async (p: string): Promise<string> => {
  const response = await fetch(BASE + p, { headers: { Cookie: cookie, Accept: "text/html" } });
  return response.ok ? response.text() : "";
};

// Discover the caller's own courses rather than hard-coding an enrolment.
const payload = (await (
  await fetch(`${BASE}/d2l/le/manageCourses/api/mycourses?pageSize=100&sort=current&orgUnitTypeId=3&embedDepth=0`, {
    headers: { Cookie: cookie, Accept: "application/json" }
  })
).json()) as { Courses?: Array<{ OrgUnitId: string | number; Name?: string; IsActive?: boolean }> };

const courses: Array<[string, string]> = (payload.Courses ?? [])
  .filter((c) => c.IsActive !== false)
  .map((c) => [c.Name ?? String(c.OrgUnitId), String(c.OrgUnitId)]);

for (const [label, ou] of courses) {
  const quizzes = parseQuizList(await html(`/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${ou}`));
  const folders = parseDropboxList(await html(`/d2l/lms/dropbox/user/folders_list.d2l?ou=${ou}`));

  console.log(`\n=== ${label} (ou=${ou}) ===`);
  console.log(`  quizzes: ${quizzes.length}, assignments: ${folders.length}`);
  for (const q of quizzes) {
    console.log(`    [quiz] ${q.state.padEnd(14)} ${q.attemptsUsed}/${q.attemptsAllowed}  id=${q.quizId ?? "-"}  ${q.name}`);
  }
  for (const f of folders) {
    console.log(`    [asgn] ${f.state.padEnd(14)} ${f.submissionCount} sub   id=${f.folderId ?? "-"}  ${f.name}`);
  }
}
