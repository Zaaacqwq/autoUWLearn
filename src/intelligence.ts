import type { Announcement, Course, DueItem, LinkItem, NormalizedCourse, ParsedPage } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

const DATE_TIME_PATTERN =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s+(\d{4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM))?/gi;

export function normalizeCourse(course: Course): NormalizedCourse {
  return {
    courseId: course.id,
    courseName: course.name,
    courseCode: course.code,
    semester: course.semester,
    url: course.url
  };
}

export function findCourses(courses: Course[], query: string) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) {
    return courses.map(normalizeCourse);
  }

  const exact = courses.filter((course) => {
    const fields = [course.id, course.name, course.code].filter(Boolean).map((value) => normalizeSearch(value));
    return fields.some((field) => field === normalizedQuery);
  });
  if (exact.length > 0) return exact.map(normalizeCourse);

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const matches = courses.filter((course) => {
    const haystack = normalizeSearch(`${course.id} ${course.name} ${course.code ?? ""}`);
    return haystack.includes(normalizedQuery) || haystack.replace(/\s+/g, "").includes(compactQuery);
  });
  return matches.map(normalizeCourse);
}

export function activeCourses(courses: Course[]) {
  return courses
    .filter((course) => {
      const raw = course.raw as Record<string, unknown> | undefined;
      return raw?.CanAccessCourse !== false && raw?.IsActive !== false;
    })
    .map(normalizeCourse);
}

export function buildCourseResolution(courses: Course[], query?: string) {
  const matches = query?.trim() ? findCourses(courses, query) : activeCourses(courses);
  if (query?.trim() && matches.length === 0) {
    return { status: "not_found" as const, query, matches };
  }
  if (query?.trim() && matches.length > 1) {
    return { status: "ambiguous" as const, query, matches };
  }
  return { status: "resolved" as const, query, matches };
}

export function dueItemsFromPage(
  page: ParsedPage,
  course: NormalizedCourse,
  type: DueItem["type"]
): DueItem[] {
  if (type === "calendar") {
    return dedupeDueItems(dueItemsFromCalendarText(page, course));
  }

  const rowItems = page.rows.flatMap((row) => dueItemsFromRow(row, page, course, type));
  if (rowItems.length > 0) return dedupeDueItems(rowItems);

  if (page.emptyState) return [];
  return dedupeDueItems(dueItemsFromText(page.text, page, course, type));
}

export function dueItemsFromContent(
  topics: Array<{ title: string; url?: string; type?: string }>,
  source: string,
  course: NormalizedCourse
): DueItem[] {
  return dedupeDueItems(
    topics.flatMap((topic) => {
      const text = topic.title;
      const due = chooseDueDate(text);
      if (!due && !/\bdue\b|deadline|until|available/i.test(text)) return [];
      return [
        {
          ...courseFields(course),
          type: "content" as const,
          title: stripDateNoise(text) || topic.title,
          dueAt: due?.dueAt,
          dueText: due?.dueText,
          url: topic.url,
          source
        }
      ];
    })
  );
}

export function dueItemsFromUpdates(updates: string[], source: string, course: NormalizedCourse): DueItem[] {
  return dedupeDueItems(
    updates.flatMap((update) => {
      const due = chooseDueDate(update);
      if (!due && !/\bdue\b|deadline|until|available/i.test(update)) return [];
      return [
        {
          ...courseFields(course),
          type: "update" as const,
          title: stripDateNoise(update).slice(0, 180) || update.slice(0, 180),
          dueAt: due?.dueAt,
          dueText: due?.dueText,
          source
        }
      ];
    })
  );
}

export function normalizeAnnouncements(
  lines: string[],
  links: LinkItem[],
  source: string,
  course: NormalizedCourse,
  limit: number
): Announcement[] {
  const candidates = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^announcements?$/i.test(line))
    .filter((line) => !/UI\.Init|D2L\.OR|session expires/i.test(line));

  const announcementLinks = links.filter((link) => /news|announcement|\/news\//i.test(`${link.label} ${link.url}`));
  const announcements: Announcement[] = [];

  for (const [index, line] of candidates.entries()) {
    const posted = chooseDueDate(line);
    const linked = announcementLinks.find((link) => line.includes(link.label) || link.label.includes(line.slice(0, 40)));
    announcements.push({
      ...courseFields(course),
      title: extractAnnouncementTitle(line),
      postedAt: posted?.dueAt,
      body: line,
      url: linked?.url,
      source
    });
    if (announcements.length >= limit) break;
    if (index > 50) break;
  }

  if (announcements.length === 0) {
    for (const link of announcementLinks.slice(0, limit)) {
      announcements.push({
        ...courseFields(course),
        title: link.label,
        body: link.label,
        url: link.url,
        source
      });
    }
  }

  return announcements.slice(0, limit);
}

export function announcementsFromPage(
  page: ParsedPage,
  course: NormalizedCourse,
  limit: number
): Announcement[] {
  const items: Announcement[] = [];
  for (const row of page.rows) {
    const titleValue = row.Title ?? row.Headline;
    const dateValue = row["Start Date"] ?? row["Posted Date"] ?? row.Date ?? "";
    if (!titleValue || isAnnouncementSearchNoise(titleValue)) continue;
    if (/results per page|show search options|search in|posted in|headline\s*content/i.test(titleValue)) continue;

    const cleanTitle = titleValue.replace(/\s*\(dismissed\)\s*$/i, "").trim();
    const linked = bestPageLink(page.links, cleanTitle);
    const posted = chooseDueDate(dateValue);
    items.push({
      ...courseFields(course),
      title: cleanTitle,
      postedAt: posted?.dueAt,
      body: cleanTitle,
      url: linked?.url,
      source: page.source
    });
    if (items.length >= limit) break;
  }

  if (items.length > 0) return items;

  return normalizeAnnouncements([], page.links, page.source, course, limit).filter(
    (announcement) => !isAnnouncementSearchNoise(announcement.title)
  );
}

function isAnnouncementSearchNoise(value: string): boolean {
  return /show search options|search in|posted in|date range|include global|include dismissed|results per page|^title$|^headline$|^content$/i.test(
    value
  );
}

export function filterUpcoming(items: DueItem[], daysAhead: number, now = new Date()): DueItem[] {
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const filtered = items
    .filter((item) => {
      if (!item.dueAt) return true;
      const due = new Date(item.dueAt);
      if (Number.isNaN(due.getTime())) return true;
      return due >= now && due <= end;
    })
    .sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return a.title.localeCompare(b.title);
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });
  return collapseCalendarDuplicates(filtered);
}

function dueItemsFromRow(
  row: Record<string, string>,
  page: ParsedPage,
  course: NormalizedCourse,
  type: DueItem["type"]
): DueItem[] {
  const values = Object.values(row).filter(Boolean);
  const rowText = values.join(" ");
  if (!rowText || isHeaderLike(rowText)) return [];

  const due = chooseDueDate(rowText);
  if (!due && !/\bdue\b|deadline|until|available/i.test(rowText)) return [];

  const title = stripDateNoise(firstMeaningfulCell(row) || rowText);
  const status = extractStatus(row);
  if (isCompletedStatus(status)) return [];
  return [
    {
      ...courseFields(course),
      type,
      title: title || rowText.slice(0, 180),
      dueAt: due?.dueAt,
      dueText: due?.dueText,
      status,
      source: page.source,
      url: bestPageLink(page.links, title)?.url ?? page.source
    }
  ];
}

function dueItemsFromText(
  text: string,
  page: ParsedPage,
  course: NormalizedCourse,
  type: DueItem["type"]
): DueItem[] {
  return splitSentences(text)
    .filter((line) => /\bdue\b|deadline|until|available/i.test(line))
    .slice(0, 50)
    .flatMap((line) => {
      const due = chooseDueDate(line);
      return [
        {
          ...courseFields(course),
          type,
          title: stripDateNoise(line).slice(0, 180) || line.slice(0, 180),
          dueAt: due?.dueAt,
          dueText: due?.dueText,
          source: page.source,
          url: page.source
        }
      ];
    });
}

function dueItemsFromCalendarText(page: ParsedPage, course: NormalizedCourse): DueItem[] {
  if (page.emptyState) return [];
  const listText = page.text
    .replace(/^.*?This is a list of all events in the calendars that you have currently enabled\./s, "")
    .replace(/Load More.*$/s, "");
  const courseName = course.courseName;
  const items: DueItem[] = [];

  for (const match of listText.matchAll(DATE_TIME_PATTERN)) {
    const dateText = match[0];
    const dateStart = match.index ?? 0;
    const before = listText.slice(Math.max(0, dateStart - 260), dateStart);
    const courseIndex = before.lastIndexOf(courseName);
    if (courseIndex < 0) continue;

    const rawTitle = before.slice(courseIndex + courseName.length).trim();
    if (isNoisyCalendarCandidate(rawTitle)) continue;
    const title = cleanCalendarTitle(rawTitle);
    if (!title || /\bavailable\b/i.test(title) && !/availability ends/i.test(title)) continue;
    if (!/\bdue\b|deadline|availability ends|ends\b/i.test(title)) continue;

    const due = chooseDueDate(dateText);
    items.push({
      ...courseFields(course),
      type: "calendar",
      title,
      dueAt: due?.dueAt,
      dueText: due?.dueText,
      source: page.source,
      url: page.source
    });
  }

  return items;
}

function isNoisyCalendarCandidate(text: string): boolean {
  return (
    new RegExp(DATE_TIME_PATTERN.source, "i").test(text) ||
    /\b[A-Z]{2,}\s*\d{3}\b.*?-\s*Spring\s+\d{4}/i.test(text) ||
    /\b[A-Z]{2,}\s*\d{3}\b.*?-\s*(Fall|Winter|Spring)\s+\d{4}/i.test(text)
  );
}

function chooseDueDate(text: string): { dueAt: string; dueText: string } | undefined {
  const dates = extractDates(text);
  if (dates.length === 0) return undefined;
  const selected = /\buntil\b/i.test(text) ? dates.at(-1) : dates[0];
  return selected ? { dueAt: selected.date.toISOString(), dueText: selected.text } : undefined;
}

function extractDates(text: string): Array<{ text: string; date: Date }> {
  const results: Array<{ text: string; date: Date }> = [];
  for (const match of text.matchAll(DATE_TIME_PATTERN)) {
    const month = MONTHS[match[1].toLowerCase().replace(".", "")];
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = match[4] ? Number(match[4]) : 23;
    const minute = match[5] ? Number(match[5]) : 59;
    const ampm = match[6]?.toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    const date = new Date(year, month, day, hour, minute);
    if (!Number.isNaN(date.getTime())) {
      results.push({ text: match[0], date });
    }
  }
  return results;
}

function firstMeaningfulCell(row: Record<string, string>): string {
  const entries = Object.entries(row);
  const preferred =
    entries.find(([key]) => /name|title|assignment|quiz|test|folder|event|activity|practice/i.test(key)) ??
    entries.find(([, value]) => value && !/evaluation status|attempts|status/i.test(value));
  return preferred?.[1] ?? "";
}

function extractStatus(row: Record<string, string>): string | undefined {
  const status = Object.entries(row).find(([key]) => /status|attempt|submission|completion/i.test(key));
  return status?.[1];
}

function isCompletedStatus(status: string | undefined): boolean {
  if (!status) return false;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(status);
  if (!match) return false;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && completed >= total;
}

function stripDateNoise(text: string): string {
  const spaced = text
    .replace(/([a-z0-9)])(Due(?:\s+on|\s+Date)?\b)/gi, "$1 $2")
    .replace(/([a-z0-9)])(Available(?:\s+on)?\b)/gi, "$1 $2")
    .replace(/([a-z0-9)])(Access restricted\b)/gi, "$1 $2")
    .replace(/([a-z0-9)])(Not Submitted\b)/gi, "$1 $2");
  return spaced
    .replace(/\bAccess restricted\b.*$/i, "")
    .replace(/\bAvailable on\b.*$/i, "")
    .replace(/\bDue(?: Date| on)?:?\s*.*$/i, "")
    .replace(/\buntil\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCalendarTitle(text: string): string {
  const words = text
    .replace(/\{count\}.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const doubled = words.match(/^(.+?)\s+\1$/i)?.[1];
  return (doubled ?? words).slice(0, 180).trim();
}

function isHeaderLike(text: string): boolean {
  const normalized = normalizeSearch(text);
  return (
    normalized === "evaluation status attempts" ||
    normalized === "graded tests evaluation status attempts" ||
    normalized === "practice tests evaluation status attempts" ||
    normalized === "final test evaluation status attempts"
  );
}

function bestPageLink(links: LinkItem[], title: string): LinkItem | undefined {
  const normalizedTitle = normalizeSearch(title);
  if (!normalizedTitle) return undefined;
  return links.find((link) => {
    const normalizedLabel = normalizeSearch(link.label);
    return normalizedLabel === normalizedTitle || normalizedLabel.includes(normalizedTitle);
  });
}

function splitSentences(text: string): string[] {
  return text
    .replace(/UI\.Init\(\).*$/s, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractAnnouncementTitle(line: string): string {
  return (
    line
      .replace(/^announcements?\s*/i, "")
      .split(/(?:\s+-\s+)|(?:\s+posted\s+)/i)[0]
      ?.slice(0, 180)
      .trim() || line.slice(0, 180)
  );
}

function dedupeDueItems(items: DueItem[]): DueItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.courseId}:${item.type}:${item.title}:${item.dueAt ?? item.dueText ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collapseCalendarDuplicates(items: DueItem[]): DueItem[] {
  const groups = new Map<string, DueItem[]>();
  for (const item of items) {
    const key = `${item.courseId}:${baseDueTitle(item.title)}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const collapsed: DueItem[] = [];
  for (const group of groups.values()) {
    const nonCalendar = group.filter((item) => item.type !== "calendar");
    if (nonCalendar.length > 0) {
      collapsed.push(...nonCalendar);
      continue;
    }
    collapsed.push(
      ...group.sort((a, b) => calendarPreferenceScore(a) - calendarPreferenceScore(b)).slice(0, 1)
    );
  }

  return collapsed.sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return a.title.localeCompare(b.title);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

function calendarPreferenceScore(item: DueItem): number {
  if (/\bdue\b/i.test(item.title)) return 0;
  if (/availability ends|ends\b/i.test(item.title)) return 1;
  return 2;
}

function baseDueTitle(title: string): string {
  return title
    .replace(/^lab group\s+\d+\s*-\s*\d+\s*:\s*/i, "")
    .replace(/\s+-\s+(due|availability ends|available|availability starts)\b.*$/i, "")
    .replace(/\b(dropbox|quiz|test)\b/gi, "")
    .replace(/\baccess restricted\b.*$/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim();
}

function courseFields(course: NormalizedCourse) {
  return {
    courseId: course.courseId,
    courseName: course.courseName,
    courseCode: course.courseCode
  };
}

function normalizeSearch(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
