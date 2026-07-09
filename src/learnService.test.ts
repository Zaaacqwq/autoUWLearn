import assert from "node:assert/strict";
import test from "node:test";
import { LearnPermissionError } from "./learnApi.js";
import { createLearnService } from "./learnService.js";

const NOW = Date.parse("2026-07-09T00:00:00.000Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const coursesPayload = {
  Courses: [
    { OrgUnitId: "100", Code: "ECE318_lect_1265", Name: "ECE 318 (002) - Spring 2026", IsActive: true },
    { OrgUnitId: "101", Code: "ECE318_lab_1265", Name: "ECE 318 Lab - Spring 2026", IsActive: true },
    { OrgUnitId: "200", Code: "ECE380_a_1265", Name: "ECE 380 - Spring 2026", IsActive: true },
    { OrgUnitId: "201", Code: "ECE380_b_1265", Name: "ECE 380 - Spring 2026", IsActive: true }
  ]
};

interface FakeData {
  assignments?: Record<string, unknown[]>;
  quizzes?: Record<string, { Objects: unknown[] }>;
  grades?: Record<string, unknown[]>;
  news?: Record<string, unknown[]>;
  fail?: Record<string, Error>;
}

function fakeApi(data: FakeData) {
  const pick = <T>(table: Record<string, T> | undefined, ou: string | number, fallback: T): Promise<T> => {
    const key = String(ou);
    if (data.fail?.[key]) return Promise.reject(data.fail[key]);
    return Promise.resolve(table?.[key] ?? fallback);
  };
  return {
    versions: async () => ({ le: "1.95", lp: "1.61" }),
    warmUp: async () => ({ le: "1.95", lp: "1.61" }),
    getJson: async () => ({}),
    courses: async () => coursesPayload,
    assignments: (ou: string | number) => pick(data.assignments, ou, [] as unknown[]),
    quizzes: (ou: string | number) => pick(data.quizzes, ou, { Objects: [] }),
    grades: (ou: string | number) => pick(data.grades, ou, [] as unknown[]),
    announcements: (ou: string | number) => pick(data.news, ou, [] as unknown[]),
    contentToc: async () => ({ Modules: [] })
  } as never;
}

const service = (data: FakeData) => createLearnService({ api: fakeApi(data), now: () => NOW });

test("collapses org units into courses", async () => {
  const courses = await service({}).courses();
  assert.deepEqual(courses.map((c) => c.key).sort(), ["ECE318", "ECE380"]);
});

test("gathers due items from assignments and quizzes across a course's components", async () => {
  const svc = service({
    assignments: { "100": [{ Id: 1, Name: "Report", DueDate: day(2) }] },
    quizzes: { "101": { Objects: [{ QuizId: 9, Name: "Prelab4", DueDate: day(3), IsActive: true }] } }
  });

  const { items } = await svc.upcoming({ daysAhead: 14 });
  assert.deepEqual(items.map((i) => i.title), ["Report", "Prelab4"]);
  assert.deepEqual(items.map((i) => i.type), ["assignment", "quiz"]);
  assert.equal(items[0].courseLabel, "ECE 318");
});

test("sorts due items earliest first", async () => {
  const svc = service({
    assignments: {
      "100": [{ Id: 1, Name: "Later", DueDate: day(5) }],
      "200": [{ Id: 2, Name: "Sooner", DueDate: day(1) }]
    }
  });
  const { items } = await svc.upcoming({});
  assert.deepEqual(items.map((i) => i.title), ["Sooner", "Later"]);
});

test("excludes items outside the window, in either direction", async () => {
  const svc = service({
    assignments: {
      "100": [
        { Id: 1, Name: "Past", DueDate: day(-1) },
        { Id: 2, Name: "Inside", DueDate: day(3) },
        { Id: 3, Name: "Beyond", DueDate: day(30) }
      ]
    }
  });
  const { items } = await svc.upcoming({ daysAhead: 7 });
  assert.deepEqual(items.map((i) => i.title), ["Inside"]);
});

test("falls back to the availability end date when DueDate is null", async () => {
  const svc = service({
    assignments: { "100": [{ Id: 1, Name: "Soft deadline", DueDate: null, Availability: { EndDate: day(2) } }] }
  });
  const { items } = await svc.upcoming({});
  assert.equal(items.length, 1);
  assert.equal(items[0].dueAt, day(2));
});

test("ignores items with no date at all", async () => {
  const svc = service({ assignments: { "100": [{ Id: 1, Name: "Undated", DueDate: null }] } });
  assert.equal((await svc.upcoming({})).items.length, 0);
});

test("skips hidden assignments and inactive quizzes", async () => {
  const svc = service({
    assignments: { "100": [{ Id: 1, Name: "Hidden", DueDate: day(1), IsHidden: true }] },
    quizzes: { "101": { Objects: [{ QuizId: 2, Name: "Retired", DueDate: day(1), IsActive: false }] } }
  });
  assert.equal((await svc.upcoming({})).items.length, 0);
});

test("deduplicates the same item surfaced by two sections of one course", async () => {
  const svc = service({
    assignments: {
      "200": [{ Id: 1, Name: "Lab 5", DueDate: day(2) }],
      "201": [{ Id: 2, Name: "Lab 5", DueDate: day(2) }]
    }
  });
  const { items } = await svc.upcoming({});
  assert.equal(items.length, 1, "one logical deadline, not two");
});

test("a permission error on one org unit does not sink the whole request", async () => {
  const svc = service({
    assignments: { "100": [{ Id: 1, Name: "Report", DueDate: day(2) }] },
    fail: { "201": new LearnPermissionError("/dropbox/folders/") }
  });

  const { items, errors } = await svc.upcoming({});
  assert.equal(items.length, 1);
  assert.ok(errors.length > 0, "the failure is reported, not swallowed");
  assert.equal(errors[0].orgUnitId, "201");
});

test("filters by course query", async () => {
  const svc = service({
    assignments: {
      "100": [{ Id: 1, Name: "ECE318 work", DueDate: day(1) }],
      "200": [{ Id: 2, Name: "ECE380 work", DueDate: day(1) }]
    }
  });
  const { items } = await svc.upcoming({ courseQuery: "ECE 318" });
  assert.deepEqual(items.map((i) => i.title), ["ECE318 work"]);
});

test("an unmatched course query reports not_found rather than silently returning everything", async () => {
  const result = await service({}).upcoming({ courseQuery: "MATH 999" });
  assert.equal(result.status, "not_found");
  assert.equal(result.items.length, 0);
});

test("grades carry the item name and displayed grade", async () => {
  const svc = service({
    grades: {
      "101": [
        {
          GradeObjectName: "Lab1.Post-lab.205",
          DisplayedGrade: "77 %",
          PointsNumerator: 77,
          PointsDenominator: 100,
          WeightedNumerator: 7.7,
          WeightedDenominator: 10
        }
      ]
    }
  });

  const { items } = await svc.grades();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Lab1.Post-lab.205");
  assert.equal(items[0].displayedGrade, "77 %");
  assert.deepEqual(items[0].points, { earned: 77, possible: 100 });
  assert.deepEqual(items[0].weight, { earned: 7.7, possible: 10 });
  assert.equal(items[0].courseLabel, "ECE 318");
});

test("announcements are newest first, hidden ones dropped, and limited", async () => {
  const svc = service({
    news: {
      "100": [
        { Id: 1, Title: "Old", Body: { Text: "a" }, StartDate: day(-5) },
        { Id: 2, Title: "New", Body: { Text: "b" }, StartDate: day(-1) },
        { Id: 3, Title: "Secret", Body: { Text: "c" }, StartDate: day(0), IsHidden: true }
      ]
    }
  });

  const { items } = await svc.announcements({ limit: 2 });
  assert.deepEqual(items.map((i) => i.title), ["New", "Old"]);
});
