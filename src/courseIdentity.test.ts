import assert from "node:assert/strict";
import test from "node:test";
import { findCourses, mergeOrgUnits, parseCourseCode, type OrgUnit } from "./courseIdentity.js";

// Shapes taken from the live /d2l/le/manageCourses/api/mycourses payload.
const orgUnits: OrgUnit[] = [
  { orgUnitId: "2007", code: "FR151_081_online_1265", name: "FR 151 Online - Spring 2026", isActive: true },
  { orgUnitId: "2001", code: "ECE318_lect_002_1265", name: "ECE 318 (002) - Spring 2026", isActive: true },
  { orgUnitId: "2003", code: "ECE350_lect_1265", name: "ECE 350 - Spring 2026", isActive: true },
  { orgUnitId: "2004", code: "ECE380_secta_1265", name: "ECE 380 - Spring 2026", isActive: true },
  { orgUnitId: "2005", code: "ECE327_lect_1265", name: "ECE 327 - Spring 2026", isActive: true },
  { orgUnitId: "2006", code: "ECE380_sectb_1265", name: "ECE 380 - Spring 2026", isActive: true },
  { orgUnitId: "2002", code: "ECE318_lab_1265", name: "ECE 318 Lab - Spring 2026", isActive: true },
  { orgUnitId: "930839", code: "Engineering Co-op Community", name: "Engineering Co-op Community", isActive: true }
];

test("parses subject, number and term out of a LEARN course code", () => {
  assert.deepEqual(parseCourseCode("ECE318_lect_002_1265"), { subject: "ECE", number: "318", term: "1265" });
  assert.deepEqual(parseCourseCode("FR151_081_online_1265"), { subject: "FR", number: "151", term: "1265" });
  assert.deepEqual(parseCourseCode("ECE350_lect_1265"), { subject: "ECE", number: "350", term: "1265" });
});

test("returns null for org units that are not course offerings", () => {
  assert.equal(parseCourseCode("Engineering Co-op Community"), null);
  assert.equal(parseCourseCode(""), null);
  assert.equal(parseCourseCode(null), null);
});

test("merges the org units of one course into a single course", () => {
  const courses = mergeOrgUnits(orgUnits);
  const ece318 = courses.find((c) => c.key === "ECE318");

  assert.ok(ece318, "ECE318 should exist");
  assert.equal(ece318.label, "ECE 318");
  assert.equal(ece318.orgUnitIds.length, 2, "lecture and lab are one course");
  assert.deepEqual([...ece318.orgUnitIds].sort(), ["2002", "2001"]);
});

test("keeps each org unit as a distinct component so its data stays addressable", () => {
  const ece318 = mergeOrgUnits(orgUnits).find((c) => c.key === "ECE318");
  const names = ece318?.components.map((c) => c.name).sort();
  assert.deepEqual(names, ["ECE 318 (002) - Spring 2026", "ECE 318 Lab - Spring 2026"]);
});

test("merges two sections that share a name but differ by instructor", () => {
  const ece380 = mergeOrgUnits(orgUnits).find((c) => c.key === "ECE380");
  assert.equal(ece380?.orgUnitIds.length, 2);
  assert.deepEqual([...(ece380?.orgUnitIds ?? [])].sort(), ["2006", "2004"]);
});

test("an org unit with no course code becomes its own course", () => {
  const courses = mergeOrgUnits(orgUnits);
  const coop = courses.find((c) => c.label === "Engineering Co-op Community");
  assert.ok(coop);
  assert.equal(coop.orgUnitIds.length, 1);
  assert.equal(coop.term, null);
});

test("eight org units collapse to six courses", () => {
  // FR151, ECE318, ECE350, ECE380, ECE327, Co-op
  assert.equal(mergeOrgUnits(orgUnits).length, 6);
});

test("finds a course regardless of spacing or case", () => {
  const courses = mergeOrgUnits(orgUnits);
  for (const query of ["ECE 318", "ece318", "ECE318", "  eCe  318 "]) {
    const found = findCourses(courses, query);
    assert.equal(found.length, 1, `query ${JSON.stringify(query)} should resolve`);
    assert.equal(found[0].key, "ECE318");
  }
});

test("finds a course by bare number when unambiguous", () => {
  const found = findCourses(mergeOrgUnits(orgUnits), "350");
  assert.equal(found.length, 1);
  assert.equal(found[0].key, "ECE350");
});

test("finds a non-code course by name substring", () => {
  const found = findCourses(mergeOrgUnits(orgUnits), "co-op");
  assert.equal(found.length, 1);
  assert.equal(found[0].label, "Engineering Co-op Community");
});

test("a subject-only query returns every course in that subject", () => {
  const found = findCourses(mergeOrgUnits(orgUnits), "ECE");
  assert.deepEqual(found.map((c) => c.key).sort(), ["ECE318", "ECE327", "ECE350", "ECE380"]);
});

test("an unknown query finds nothing", () => {
  assert.equal(findCourses(mergeOrgUnits(orgUnits), "MATH 999").length, 0);
});

test("an empty query returns every course", () => {
  assert.equal(findCourses(mergeOrgUnits(orgUnits), "").length, 6);
  assert.equal(findCourses(mergeOrgUnits(orgUnits), undefined).length, 6);
});
