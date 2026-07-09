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

const courses: Array<[string, number]> = [
  ["ECE 327", 900002],
  ["ECE 318 Lab", 900001],
  ["ECE 380 (b)", 900003],
  ["FR 151", 900004]
];

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
