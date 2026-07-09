import assert from "node:assert/strict";
import test from "node:test";
import { flattenToc, type RawModule } from "./contentTree.js";

// Shape taken from the live /d2l/api/le/1.95/{ou}/content/toc payload.
const toc: RawModule[] = [
  {
    ModuleId: 3002,
    Title: "Lectures",
    Topics: [
      {
        TopicId: 3001,
        Title: "01-ece327-s2026-introduction",
        TypeIdentifier: "File",
        Url: "/content/enforced/2005-ECE327/01-ece327-s2026-introduction.pdf"
      },
      { TopicId: 6534619, Title: "Hidden slide", TypeIdentifier: "File", Url: "/x.pdf", IsHidden: true }
    ],
    Modules: [
      {
        ModuleId: 70,
        Title: "Week 1",
        Topics: [
          { TopicId: 71, Title: "Reading link", TypeIdentifier: "Link", Url: "https://example.com" },
          { TopicId: 72, Title: "Notes", TypeIdentifier: "File", Url: "/content/enforced/2005-ECE327/notes.docx" }
        ]
      }
    ]
  },
  { ModuleId: 90, Title: "Secret module", IsHidden: true, Topics: [{ TopicId: 91, Title: "Nope", Url: "/n.pdf" }] }
];

test("flattens nested modules into topics", () => {
  const topics = flattenToc(toc);
  assert.deepEqual(topics.map((t) => t.title), ["01-ece327-s2026-introduction", "Reading link", "Notes"]);
});

test("records the module path so a topic can be located by a human", () => {
  const notes = flattenToc(toc).find((t) => t.title === "Notes");
  assert.deepEqual(notes?.modulePath, ["Lectures", "Week 1"]);
});

test("skips hidden topics and hidden modules", () => {
  const titles = flattenToc(toc).map((t) => t.title);
  assert.ok(!titles.includes("Hidden slide"));
  assert.ok(!titles.includes("Nope"), "a hidden module hides its topics too");
});

test("marks downloadable course files and derives their extension", () => {
  const topics = flattenToc(toc);
  const pdf = topics.find((t) => t.title.startsWith("01-ece327"));
  assert.equal(pdf?.isFile, true);
  assert.equal(pdf?.extension, "pdf");

  const docx = topics.find((t) => t.title === "Notes");
  assert.equal(docx?.extension, "docx");
});

test("an external link is not a downloadable course file", () => {
  const link = flattenToc(toc).find((t) => t.title === "Reading link");
  assert.equal(link?.isFile, false, "only /content/enforced/ paths are course files");
});

test("topic ids are strings, matching the rest of the surface", () => {
  assert.equal(typeof flattenToc(toc)[0].topicId, "string");
});

test("an empty or absent module list yields no topics", () => {
  assert.deepEqual(flattenToc([]), []);
  assert.deepEqual(flattenToc(undefined), []);
});
