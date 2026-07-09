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
  events?: Record<string, unknown[]>;
  rawAssignments?: Record<string, unknown[]>;
  rawQuizzes?: Record<string, { Objects: unknown[] }>;
  quizHtml?: Record<string, string>;
  dropboxHtml?: Record<string, string>;
  grades?: Record<string, unknown[]>;
  news?: Record<string, unknown[]>;
  toc?: Record<string, { Modules: unknown[] }>;
  files?: Record<string, { bytes: Uint8Array; contentType: string }>;
  fail?: Record<string, Error>;
  failHtml?: boolean;
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
    calendarEvents: (ou: string | number) => pick(data.events, ou, [] as unknown[]),
    fetchHtml: async (path: string) => {
      if (data.failHtml) throw new Error("status page unavailable");
      const ou = /[?&]ou=(\d+)/.exec(path)?.[1] ?? "";
      const table = /quizzing/.test(path) ? data.quizHtml : data.dropboxHtml;
      return table?.[ou] ?? "";
    },
    assignments: (ou: string | number) => pick(data.rawAssignments, ou, [] as unknown[]),
    quizzes: (ou: string | number) => pick(data.rawQuizzes, ou, { Objects: [] as unknown[] }),
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

const DUE = 6;

const dueEvent = (id: number, title: string, iso: string, assocType: string, assocId?: number) => ({
  CalendarEventId: id,
  Title: title,
  EventType: DUE,
  StartDateTime: iso,
  EndDateTime: iso,
  AssociatedEntity: { AssociatedEntityType: assocType, AssociatedEntityId: assocId }
});

const DROPBOX = "D2L.LE.Dropbox.Dropbox";
const QUIZ = "D2L.LE.Quizzing.Quiz";
const MODULE = "D2L.LE.Content.ContentObject.ModuleCO";

const quizRows = (rows: Array<[string, number]>) => `<table>${rows
  .map(([name, used]) => `<tr><td><a href="javascript://">${name}</a></td><td></td><td>${used} / 1</td></tr>`)
  .join("")}</table>`;

const dropboxRows = (rows: Array<[string, string, number | null]>) => `<table>${rows
  .map(([name, completion, id]) => {
    const link = id === null ? completion : `<a href="/x?db=${id}">${completion}</a>`;
    return `<tr><th>${name}</th><td>${link}</td><td>- / -</td><td></td></tr>`;
  })
  .join("")}</table>`;

test("deadlines come from the calendar, covering assignments, quizzes and modules", async () => {
  const svc = service({
    events: {
      "100": [
        dueEvent(1, "Report", day(2), DROPBOX, 5001),
        dueEvent(2, "Prelab4", day(3), QUIZ),
        dueEvent(3, "Assignment 4", day(4), MODULE, 600001)
      ]
    }
  });

  const { items } = await svc.upcoming({ daysAhead: 14 });
  assert.deepEqual(items.map((i) => i.title), ["Report", "Prelab4", "Assignment 4"]);
  assert.deepEqual(items.map((i) => i.type), ["assignment", "quiz", "module"]);
  assert.equal(items[0].courseLabel, "ECE 318");
});

test("a content-module deadline is reported, and has no submission status to read", async () => {
  // The regression: ECE 380's "Assignment 4" is a content module with a due
  // date, living in an org unit whose dropbox folder list is empty. Sourcing
  // deadlines from dropbox folders and quizzes could never have found it.
  const svc = service({ events: { "200": [dueEvent(9, "Assignment 4", day(6), MODULE, 600001)] } });

  const { items } = await svc.upcoming({});
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "module");
  assert.equal(items[0].submissionStatus, "not_applicable", "nothing is handed in through LEARN for a module");
});

test("a plain event is not a deadline", async () => {
  const svc = service({
    events: {
      "100": [
        { CalendarEventId: 2, Title: "ECE 318 Lab", EventType: 1, StartDateTime: day(1), EndDateTime: day(1) },
        dueEvent(3, "Real deadline", day(1), DROPBOX, 1)
      ]
    }
  });
  assert.deepEqual((await svc.upcoming({})).items.map((i) => i.title), ["Real deadline"]);
});

test("an availability end is the deadline when the item has no due date", async () => {
  // FR 151's tests close on availability and carry no due date at all. Filtering
  // to EventType 6 alone silently dropped them.
  const availEnds = (id: number, title: string, iso: string) => ({
    CalendarEventId: id,
    Title: title,
    EventType: 3,
    StartDateTime: iso,
    EndDateTime: iso,
    AssociatedEntity: { AssociatedEntityType: QUIZ, AssociatedEntityId: id }
  });
  const svc = service({ events: { "100": [availEnds(1, "Test #4", day(1))] } });

  const { items } = await svc.upcoming({});
  assert.deepEqual(items.map((i) => i.title), ["Test #4"]);
  assert.equal(items[0].dueAt, day(1));
});

test("a due date wins over the same entity's availability end", async () => {
  // Prelab4 is due at 12:00 and closes at 12:30; the deadline is 12:00, once.
  const entity = { AssociatedEntityType: QUIZ, AssociatedEntityId: 77 };
  const svc = service({
    events: {
      "100": [
        { CalendarEventId: 1, Title: "Prelab4", EventType: 6, StartDateTime: day(2), EndDateTime: day(2), AssociatedEntity: entity },
        { CalendarEventId: 2, Title: "Prelab4", EventType: 3, StartDateTime: day(3), EndDateTime: day(3), AssociatedEntity: entity }
      ]
    }
  });

  const { items } = await svc.upcoming({});
  assert.equal(items.length, 1, "one deadline per entity, not two");
  assert.equal(items[0].dueAt, day(2), "the due date, not the grace period");
});

test("deadlines the calendar omits still arrive from dropbox and quizzes", async () => {
  // ECE 327's calendar holds zero events, yet all its quizzes are dated. The
  // calendar alone is not a complete source either.
  const svc = service({
    events: {},
    rawAssignments: { "100": [{ Id: 5, Name: "Report", DueDate: day(2) }] },
    rawQuizzes: { "101": { Objects: [{ QuizId: 6, Name: "Lab3 Quiz", EndDate: day(3), IsActive: true }] } }
  });

  const { items } = await svc.upcoming({});
  assert.deepEqual(items.map((i) => i.title), ["Report", "Lab3 Quiz"]);
  assert.deepEqual(items.map((i) => i.type), ["assignment", "quiz"]);
});

test("a deadline reported by both the calendar and the API appears once", async () => {
  const svc = service({
    events: { "100": [dueEvent(1, "Report", day(2), DROPBOX, 5)] },
    rawAssignments: { "100": [{ Id: 5, Name: "Report", DueDate: day(2) }] }
  });

  assert.equal((await svc.upcoming({})).items.length, 1);
});

test("sorts deadlines earliest first", async () => {
  const svc = service({
    events: {
      "100": [dueEvent(1, "Later", day(5), DROPBOX, 1)],
      "200": [dueEvent(2, "Sooner", day(1), DROPBOX, 2)]
    }
  });
  assert.deepEqual((await svc.upcoming({})).items.map((i) => i.title), ["Sooner", "Later"]);
});

test("excludes deadlines outside the window, in either direction", async () => {
  const svc = service({
    events: {
      "100": [
        dueEvent(1, "Past", day(-1), DROPBOX, 1),
        dueEvent(2, "Inside", day(3), DROPBOX, 2),
        dueEvent(3, "Beyond", day(30), DROPBOX, 3)
      ]
    }
  });
  assert.deepEqual((await svc.upcoming({ daysAhead: 7 })).items.map((i) => i.title), ["Inside"]);
});

test("deduplicates a deadline reported by two sections of one course", async () => {
  const svc = service({
    events: {
      "200": [dueEvent(1, "Lab 5", day(2), DROPBOX, 7)],
      "201": [dueEvent(2, "Lab 5", day(2), DROPBOX, 7)]
    }
  });
  assert.equal((await svc.upcoming({})).items.length, 1, "one logical deadline, not two");
});

test("filters by course query", async () => {
  const svc = service({
    events: {
      "100": [dueEvent(1, "ECE318 work", day(1), DROPBOX, 1)],
      "200": [dueEvent(2, "ECE380 work", day(1), DROPBOX, 2)]
    }
  });
  assert.deepEqual((await svc.upcoming({ courseQuery: "ECE 318" })).items.map((i) => i.title), ["ECE318 work"]);
});

test("an unmatched course query reports not_found rather than silently returning everything", async () => {
  const result = await service({}).upcoming({ courseQuery: "MATH 999" });
  assert.equal(result.status, "not_found");
  assert.equal(result.items.length, 0);
});

test("a permission error on one org unit does not sink the whole request", async () => {
  const svc = service({
    events: { "100": [dueEvent(1, "Report", day(2), DROPBOX, 1)] },
    fail: { "201": new LearnPermissionError("/calendar/events/") }
  });

  const { items, errors } = await svc.upcoming({});
  assert.equal(items.length, 1);
  assert.ok(errors.length > 0, "the failure is reported, not swallowed");
  assert.equal(errors[0].orgUnitId, "201");
});

test("joins quiz submission status by name", async () => {
  const svc = service({
    events: { "101": [dueEvent(1, "Prelab4", day(2), QUIZ), dueEvent(2, "Prelab5", day(3), QUIZ)] },
    quizHtml: { "101": quizRows([["Prelab4", 1], ["Prelab5", 0]]) }
  });

  const { items } = await svc.upcoming({});
  assert.equal(items.find((i) => i.title === "Prelab4")?.submissionStatus, "submitted");
  assert.equal(items.find((i) => i.title === "Prelab5")?.submissionStatus, "not_submitted");
});

test("joins assignment submission status by folder id", async () => {
  const svc = service({
    events: { "200": [dueEvent(1, "Lab 5 - 205", day(2), DROPBOX, 800002)] },
    dropboxHtml: { "200": dropboxRows([["Lab Group 205 - 6: Lab 5 - 205", "Not Submitted", 800002]]) }
  });

  assert.equal((await svc.upcoming({})).items[0].submissionStatus, "not_submitted");
});

test("falls back to the folder name when the row carries no id", async () => {
  // A row that links to no history page has no db= parameter to read.
  const svc = service({
    events: { "200": [dueEvent(1, "Oral Assignment Dropbox", day(2), DROPBOX, 800004)] },
    dropboxHtml: { "200": dropboxRows([["Oral Assignment Dropbox", "Not Submitted", null]]) }
  });

  assert.equal((await svc.upcoming({})).items[0].submissionStatus, "not_submitted");
});

test("an unreadable status page yields unknown rather than failing the request", async () => {
  const svc = service({
    events: { "100": [dueEvent(1, "Report", day(2), DROPBOX, 1)] },
    failHtml: true
  });

  const { items } = await svc.upcoming({});
  assert.equal(items.length, 1, "the deadline still comes back");
  assert.equal(items[0].submissionStatus, "unknown");
});

test("renders the deadline in the configured timezone alongside the UTC instant", async () => {
  // 2026-07-16T03:59Z is 11:59 p.m. on July 15 in Toronto: the date differs.
  const svc = service({ events: { "100": [dueEvent(1, "Assignment 4", "2026-07-16T03:59:00.000Z", MODULE)] } });

  const item = (await svc.upcoming({ daysAhead: 30 })).items[0];
  assert.equal(item.dueAt, "2026-07-16T03:59:00.000Z");
  assert.match(item.dueAtLocal, /Jul(y)? 15, 2026/);
  assert.match(item.dueAtLocal, /11:59/);
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
