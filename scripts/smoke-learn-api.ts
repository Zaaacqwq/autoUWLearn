/**
 * Live smoke test for the Valence API client. Reads the saved LEARN session and
 * fetches every course's grades, assignments, quizzes and announcements.
 *
 *   npx tsx scripts/smoke-learn-api.ts
 *
 * Read-only. Prints counts and timings, never grade values.
 */
import os from "node:os";
import path from "node:path";
import { cookieHeaderFromStorageState } from "../src/cookieSource.js";
import { createLearnApi } from "../src/learnApi.js";

const storageState =
  process.env.LEARN_STORAGE_STATE_PATH ?? path.resolve(os.homedir(), ".uwlearn-mcp", "storage-state.json");

const api = createLearnApi({
  cookieHeader: () => cookieHeaderFromStorageState(storageState, "learn.uwaterloo.ca")
});

interface CourseItem {
  readonly OrgUnitId: number;
  readonly Code?: string;
  readonly IsActive?: boolean;
}

const versions = await api.versions();
console.log(`api versions: le=${versions.le} lp=${versions.lp}`);

const started = Date.now();
const payload = await api.courses<{ Courses?: CourseItem[] }>();
const courses = (payload.Courses ?? []).filter((course) => course.IsActive);
console.log(`courses: ${courses.length} active (${Date.now() - started}ms)\n`);

const fanOut = Date.now();
const rows = await Promise.all(
  courses.map(async (course) => {
    const [grades, assignments, quizzes, announcements] = await Promise.all([
      api.grades<unknown[]>(course.OrgUnitId).catch((error: Error) => error.name),
      api.assignments<unknown[]>(course.OrgUnitId).catch((error: Error) => error.name),
      api.quizzes<{ Objects?: unknown[] }>(course.OrgUnitId).catch((error: Error) => error.name),
      api.announcements<unknown[]>(course.OrgUnitId).catch((error: Error) => error.name)
    ]);
    const size = (value: unknown): string =>
      Array.isArray(value) ? String(value.length) : typeof value === "string" ? value : "?";
    return {
      code: course.Code ?? String(course.OrgUnitId),
      grades: size(grades),
      assignments: size(assignments),
      quizzes: Array.isArray((quizzes as { Objects?: unknown[] })?.Objects)
        ? String((quizzes as { Objects: unknown[] }).Objects.length)
        : size(quizzes),
      announcements: size(announcements)
    };
  })
);
const elapsed = Date.now() - fanOut;

console.log("course                        grades  assign  quiz  announce");
for (const row of rows) {
  console.log(
    `${row.code.slice(0, 28).padEnd(29)} ${row.grades.padEnd(7)} ${row.assignments.padEnd(7)} ${row.quizzes.padEnd(5)} ${row.announcements}`
  );
}
console.log(`\n${courses.length * 4} requests, concurrency 4, total ${elapsed}ms`);
