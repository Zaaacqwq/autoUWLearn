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
  toc?: Record<string, { Modules: unknown[] }>;
  files?: Record<string, { bytes: Uint8Array; contentType: string }>;
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
    contentToc: (ou: string | number) => pick(data.toc, ou, { Modules: [] as unknown[] }),
    fetchFile: async (path: string) => {
      const file = data.files?.[path];
      if (!file) throw new Error(`no stub file for ${path}`);
      return { bytes: file.bytes, contentType: file.contentType, url: `https://learn.uwaterloo.ca${path}` };
    }
  } as never;
}

const LECTURE_URL = "/content/enforced/100-ECE318/lecture-01.pdf";
const LAB_URL = "/content/enforced/101-ECE318/lab-01.pdf";

const tocWith = (topics: unknown[]) => ({ Modules: [{ ModuleId: 1, Title: "Lectures", Topics: topics }] });

const topic = (id: number, title: string, url: string) => ({
  TopicId: id,
  Title: title,
  TypeIdentifier: "File",
  Url: url
});

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
          GradeObjectName: "Lab1.Post-lab",
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
  assert.equal(items[0].name, "Lab1.Post-lab");
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

const HELLO_PDF = new Uint8Array(
  Buffer.from(
    "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgoyMCAxMDAgVGQKKEhlbGxvIFBERikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NiAwMDAwMCBuIAowMDAwMDAwMTExIDAwMDAwIG4gCjAwMDAwMDAyMzUgMDAwMDAgbiAKMDAwMDAwMDMwNCAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM5OAolJUVPRgo=",
    "base64"
  )
);

test("content lists topics from every component of a course", async () => {
  const svc = service({
    toc: {
      "100": tocWith([topic(1, "Lecture 01", LECTURE_URL)]),
      "101": tocWith([topic(2, "Lab 01", LAB_URL)])
    }
  });

  const { items } = await svc.content("ECE 318");
  assert.deepEqual(items.map((t) => t.title).sort(), ["Lab 01", "Lecture 01"]);
  assert.ok(items.every((t) => t.courseLabel === "ECE 318"));
});

test("readTopic extracts the text of a matched lecture", async () => {
  const svc = service({
    toc: { "100": tocWith([topic(1, "Lecture 01 Introduction", LECTURE_URL)]) },
    files: { [LECTURE_URL]: { bytes: HELLO_PDF, contentType: "application/pdf" } }
  });

  const result = await svc.readTopic({ topicQuery: "introduction", courseQuery: "ECE 318" });
  assert.equal(result.status, "ok");
  assert.match(result.text ?? "", /Hello PDF/);
  assert.equal(result.pages, 1);
  assert.equal(result.topic?.title, "Lecture 01 Introduction");
});

test("readTopic matches on topic id exactly", async () => {
  const svc = service({
    toc: { "100": tocWith([topic(1, "Lecture 01", LECTURE_URL), topic(2, "Lecture 02", LAB_URL)]) },
    files: { [LAB_URL]: { bytes: HELLO_PDF, contentType: "application/pdf" } }
  });

  const result = await svc.readTopic({ topicQuery: "2", courseQuery: "ECE 318" });
  assert.equal(result.status, "ok");
  assert.equal(result.topic?.title, "Lecture 02");
});

test("readTopic reports candidates instead of guessing between them", async () => {
  const svc = service({
    toc: { "100": tocWith([topic(1, "Lecture 01", LECTURE_URL), topic(2, "Lecture 02", LAB_URL)]) }
  });

  const result = await svc.readTopic({ topicQuery: "lecture", courseQuery: "ECE 318" });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates?.length, 2);
  assert.equal(result.text, undefined);
});

test("readTopic ignores topics that are external links, not course files", async () => {
  const svc = service({
    toc: {
      "100": {
        Modules: [
          { ModuleId: 1, Title: "Lectures", Topics: [{ TopicId: 5, Title: "Slides", TypeIdentifier: "Link", Url: "https://example.com/slides" }] }
        ]
      }
    }
  });

  assert.equal((await svc.readTopic({ topicQuery: "slides", courseQuery: "ECE 318" })).status, "not_found");
});

test("readTopic truncates very long documents and says so", async () => {
  const svc = service({
    toc: { "100": tocWith([topic(1, "Lecture 01", LECTURE_URL)]) },
    files: { [LECTURE_URL]: { bytes: HELLO_PDF, contentType: "application/pdf" } }
  });

  const result = await svc.readTopic({ topicQuery: "lecture 01", courseQuery: "ECE 318", maxChars: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.text?.length, 5);
});
