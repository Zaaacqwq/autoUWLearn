/**
 * One Brightspace org unit. A course is usually split across several: a lecture
 * offering, a lab offering, and sometimes one org unit per section.
 */
export interface OrgUnit {
  readonly orgUnitId: string;
  readonly code: string | null;
  readonly name: string;
  readonly isActive: boolean;
}

export interface CourseComponent {
  readonly orgUnitId: string;
  readonly name: string;
  readonly code: string | null;
}

export interface Course {
  /** Stable identity, e.g. "ECE318", or "ou:930839" when there is no course code. */
  readonly key: string;
  /** Human label, e.g. "ECE 318". */
  readonly label: string;
  readonly term: string | null;
  readonly components: readonly CourseComponent[];
  readonly orgUnitIds: readonly string[];
}

export interface ParsedCourseCode {
  readonly subject: string;
  readonly number: string;
  readonly term: string | null;
}

// e.g. ECE318_lect_002_1265, FR151_081_online_1265
const COURSE_CODE = /^([A-Za-z]{2,4})\s*(\d{3}[A-Za-z]?)(?:_|$)/;
const TERM_SUFFIX = /_(\d{4})$/;

export function parseCourseCode(code: string | null | undefined): ParsedCourseCode | null {
  if (!code) return null;

  const match = COURSE_CODE.exec(code.trim());
  if (!match) return null;

  return {
    subject: match[1].toUpperCase(),
    number: match[2].toUpperCase(),
    term: TERM_SUFFIX.exec(code)?.[1] ?? null
  };
}

/**
 * Groups org units that belong to the same course. Components are preserved
 * rather than collapsed: ECE 318's lecture and lab hold different assignments
 * and grades, and both must stay reachable.
 */
export function mergeOrgUnits(orgUnits: readonly OrgUnit[]): Course[] {
  const byKey = new Map<string, { parsed: ParsedCourseCode | null; units: OrgUnit[] }>();

  for (const unit of orgUnits) {
    const parsed = parseCourseCode(unit.code);
    const key = parsed ? `${parsed.subject}${parsed.number}` : `ou:${unit.orgUnitId}`;
    const bucket = byKey.get(key) ?? { parsed, units: [] };
    bucket.units.push(unit);
    byKey.set(key, bucket);
  }

  return [...byKey.entries()].map(([key, { parsed, units }]) => ({
    key,
    label: parsed ? `${parsed.subject} ${parsed.number}` : units[0].name,
    term: parsed?.term ?? null,
    components: units.map((unit) => ({ orgUnitId: unit.orgUnitId, name: unit.name, code: unit.code })),
    orgUnitIds: units.map((unit) => unit.orgUnitId)
  }));
}

const squash = (value: string): string => value.replace(/[\s_-]+/g, "").toUpperCase();

/**
 * Resolves a free-text course query. Callers get every match and decide what to
 * do; this never guesses between candidates.
 */
export function findCourses(courses: readonly Course[], query: string | undefined): Course[] {
  const trimmed = query?.trim();
  if (!trimmed) return [...courses];

  const needle = squash(trimmed);

  const exact = courses.filter((course) => course.key === needle);
  if (exact.length > 0) return exact;

  // Bare course number, e.g. "350".
  if (/^\d{3}[A-Z]?$/.test(needle)) {
    const byNumber = courses.filter((course) => course.key.endsWith(needle));
    if (byNumber.length > 0) return byNumber;
  }

  // Subject prefix, e.g. "ECE".
  if (/^[A-Z]{2,4}$/.test(needle)) {
    const bySubject = courses.filter((course) => course.key.startsWith(needle));
    if (bySubject.length > 0) return bySubject;
  }

  return courses.filter(
    (course) => squash(course.label).includes(needle) || course.components.some((c) => squash(c.name).includes(needle))
  );
}
