import { flattenToc, type ContentTopic, type RawModule } from "./contentTree.js";
import { findCourses, mergeOrgUnits, type Course, type OrgUnit } from "./courseIdentity.js";
import { extractDocumentText } from "./extractText.js";
import { CALENDAR_EVENT_TYPE, type CalendarEvent, type LearnApi } from "./learnApi.js";
import { parseDropboxList, parseQuizList, type SubmissionState } from "./submissionStatus.js";

export type ResolutionStatus = "ok" | "not_found";

export interface OrgUnitError {
  readonly orgUnitId: string;
  readonly courseLabel: string;
  readonly source: string;
  readonly error: string;
  readonly message: string;
}

export type DueItemKind = "assignment" | "quiz" | "module" | "discussion" | "other";

/**
 * `not_applicable` is a content module or similar: it carries a deadline but
 * nothing is handed in through LEARN, so "did I submit it?" has no answer here.
 * `unknown` means we could not read the status page.
 */
export type DueSubmissionStatus = "submitted" | "not_submitted" | "not_applicable" | "unknown";

export interface DueItem {
  readonly type: DueItemKind;
  readonly id: string;
  readonly title: string;
  /** UTC instant. */
  readonly dueAt: string;
  /** The same instant rendered in the configured timezone, for the model. */
  readonly dueAtLocal: string;
  readonly submissionStatus: DueSubmissionStatus;
  readonly courseKey: string;
  readonly courseLabel: string;
  readonly orgUnitId: string;
}

export interface GradeItem {
  readonly name: string;
  readonly displayedGrade: string | null;
  readonly points: { readonly earned: number; readonly possible: number } | null;
  readonly weight: { readonly earned: number; readonly possible: number } | null;
  readonly courseKey: string;
  readonly courseLabel: string;
  readonly orgUnitId: string;
}

export interface Announcement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly postedAt: string | null;
  readonly courseKey: string;
  readonly courseLabel: string;
  readonly orgUnitId: string;
}

export interface Result<T> {
  readonly status: ResolutionStatus;
  readonly query?: string;
  readonly courses: readonly Course[];
  readonly items: readonly T[];
  readonly errors: readonly OrgUnitError[];
}

export interface LearnServiceOptions {
  readonly api: LearnApi;
  readonly now?: () => number;
  /** IANA zone used to render dueAtLocal. */
  readonly timeZone?: string;
}

export interface CourseTopic extends ContentTopic {
  readonly courseKey: string;
  readonly courseLabel: string;
  readonly orgUnitId: string;
}

export interface ReadTopicResult {
  readonly status: "ok" | "not_found" | "ambiguous";
  readonly query?: string;
  readonly topic?: CourseTopic;
  readonly candidates?: readonly CourseTopic[];
  readonly text?: string;
  readonly pages?: number | null;
  readonly bytes?: number;
  readonly truncated?: boolean;
}

export interface LearnService {
  courses(): Promise<Course[]>;
  upcoming(options?: { daysAhead?: number; courseQuery?: string }): Promise<Result<DueItem>>;
  grades(courseQuery?: string): Promise<Result<GradeItem>>;
  announcements(options?: { courseQuery?: string; limit?: number }): Promise<Result<Announcement>>;
  content(courseQuery?: string): Promise<Result<CourseTopic>>;
  readTopic(options: {
    topicQuery: string;
    courseQuery?: string;
    maxChars?: number;
  }): Promise<ReadTopicResult>;
}

interface RawCourse {
  readonly OrgUnitId: string | number;
  readonly Code?: string | null;
  readonly Name?: string;
  readonly IsActive?: boolean;
}

interface RawAssignment {
  readonly Id?: number;
  readonly Name?: string;
  readonly DueDate?: string | null;
  readonly IsHidden?: boolean;
  readonly Availability?: { readonly EndDate?: string | null } | null;
}

interface RawQuiz {
  readonly QuizId?: number;
  readonly Name?: string;
  readonly DueDate?: string | null;
  readonly EndDate?: string | null;
  readonly IsActive?: boolean;
}

interface RawGradeValue {
  readonly GradeObjectName?: string;
  readonly DisplayedGrade?: string | null;
  readonly PointsNumerator?: number | null;
  readonly PointsDenominator?: number | null;
  readonly WeightedNumerator?: number | null;
  readonly WeightedDenominator?: number | null;
}

interface RawNews {
  readonly Id?: number;
  readonly Title?: string;
  readonly Body?: { readonly Text?: string; readonly Html?: string } | null;
  readonly StartDate?: string | null;
  readonly IsHidden?: boolean;
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

const pair = (
  earned: number | null | undefined,
  possible: number | null | undefined
): { earned: number; possible: number } | null =>
  typeof earned === "number" && typeof possible === "number" ? { earned, possible } : null;

export function createLearnService(options: LearnServiceOptions): LearnService {
  const { api } = options;
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? "America/Toronto";

  /** LEARN returns UTC. A model reading "03:59Z" should not have to guess. */
  const renderLocal = (iso: string): string => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    return at.toLocaleString("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" });
  };

  const submissionFor = (
    kind: DueItemKind,
    title: string,
    entityId: number | undefined,
    status: Awaited<ReturnType<typeof statusFor>> | null
  ): DueSubmissionStatus => {
    // Nothing is handed in through LEARN for these, so there is no status to read.
    if (kind === "module" || kind === "discussion" || kind === "other") return "not_applicable";
    if (!status) return "unknown";

    if (kind === "quiz") return status.quizzesByName.get(title) ?? "unknown";

    // An assignment's folder id is the calendar event's associated entity, but a
    // row that links to no history page carries none, so fall back to the name.
    const byId = entityId === undefined ? undefined : status.foldersById.get(String(entityId));
    return byId ?? status.foldersByName.get(title) ?? "unknown";
  };

  async function courses(): Promise<Course[]> {
    const payload = await api.courses<{ Courses?: RawCourse[] }>();
    const orgUnits: OrgUnit[] = (payload.Courses ?? []).map((course) => ({
      orgUnitId: String(course.OrgUnitId),
      code: course.Code ?? null,
      name: course.Name ?? String(course.OrgUnitId),
      isActive: course.IsActive !== false
    }));
    return mergeOrgUnits(orgUnits.filter((unit) => unit.isActive));
  }

  async function resolve(query?: string): Promise<{ status: ResolutionStatus; matched: Course[] }> {
    const all = await courses();
    const matched = findCourses(all, query);
    return { status: query?.trim() && matched.length === 0 ? "not_found" : "ok", matched };
  }

  /**
   * Runs `fetcher` for every org unit of every matched course. One org unit
   * failing (a lab you cannot see, a transient 500) must not lose the data from
   * the others, so failures are collected alongside the results.
   */
  async function fanOut<T>(
    matched: readonly Course[],
    source: string,
    fetcher: (orgUnitId: string, course: Course) => Promise<T[]>
  ): Promise<{ items: T[]; errors: OrgUnitError[] }> {
    const items: T[] = [];
    const errors: OrgUnitError[] = [];

    const tasks = matched.flatMap((course) =>
      course.orgUnitIds.map(async (orgUnitId) => {
        try {
          items.push(...(await fetcher(orgUnitId, course)));
        } catch (cause) {
          const error = asError(cause);
          errors.push({
            orgUnitId,
            courseLabel: course.label,
            source,
            error: error.name,
            message: error.message
          });
        }
      })
    );

    await Promise.all(tasks);
    return { items, errors };
  }

  const kindOf = (associatedType: string | undefined): DueItemKind => {
    if (!associatedType) return "other";
    if (associatedType.endsWith("Dropbox")) return "assignment";
    if (associatedType.endsWith("Quiz")) return "quiz";
    if (associatedType.endsWith("ModuleCO")) return "module";
    if (associatedType.endsWith("DiscussionForum")) return "discussion";
    return "other";
  };

  /**
   * Reads the two pages that state submission status. The Valence API has no
   * student-visible equivalent, so this is the only source.
   */
  async function statusFor(orgUnitId: string): Promise<{
    quizzesByName: Map<string, SubmissionState>;
    foldersById: Map<string, SubmissionState>;
    foldersByName: Map<string, SubmissionState>;
  }> {
    const [quizHtml, dropboxHtml] = await Promise.all([
      api.fetchHtml(`/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${orgUnitId}`),
      api.fetchHtml(`/d2l/lms/dropbox/user/folders_list.d2l?ou=${orgUnitId}`)
    ]);

    const quizzesByName = new Map(parseQuizList(quizHtml).map((q) => [q.name, q.state]));
    const folders = parseDropboxList(dropboxHtml);
    return {
      quizzesByName,
      foldersById: new Map(folders.flatMap((f) => (f.folderId ? [[f.folderId, f.state] as const] : []))),
      foldersByName: new Map(folders.map((f) => [f.shortName, f.state]))
    };
  }

  /**
   * A calendar entity's effective deadline.
   *
   * An entity emits up to three events: availability starts, due, availability
   * ends. Prefer the due date. Some items have no due date at all and close on
   * availability instead — FR 151's tests are like that — and for them the
   * availability end *is* the deadline. Ignoring that loses real deadlines.
   */
  const effectiveDeadlines = (events: readonly CalendarEvent[]): CalendarEvent[] => {
    const byEntity = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      if (event.EventType !== CALENDAR_EVENT_TYPE.due && event.EventType !== CALENDAR_EVENT_TYPE.availabilityEnds) {
        continue;
      }
      const key = `${event.AssociatedEntity?.AssociatedEntityId ?? "none"}|${event.Title}`;
      const group = byEntity.get(key) ?? [];
      group.push(event);
      byEntity.set(key, group);
    }

    return [...byEntity.values()].flatMap((group) => {
      const chosen =
        group.find((event) => event.EventType === CALENDAR_EVENT_TYPE.due) ??
        group.find((event) => event.EventType === CALENDAR_EVENT_TYPE.availabilityEnds);
      return chosen ? [chosen] : [];
    });
  };

  /**
   * Deadlines are the union of three sources, because none of them is complete.
   *
   * - The calendar carries deadlines the others cannot express: ECE 380's
   *   Assignment 4 is a content module with a due date, in an org unit whose
   *   dropbox folder list is empty.
   * - dropbox/folders and quizzes carry deadlines the calendar omits: ECE 327's
   *   quizzes are all dated, and its calendar holds zero events.
   *
   * Verified against the live account; neither source alone answers "what is
   * due". Duplicates across sources collapse on (course, title, instant).
   */
  async function upcoming(input: { daysAhead?: number; courseQuery?: string } = {}): Promise<Result<DueItem>> {
    const daysAhead = input.daysAhead ?? 14;
    const { status, matched } = await resolve(input.courseQuery);
    if (status === "not_found") {
      return { status, query: input.courseQuery, courses: [], items: [], errors: [] };
    }

    const from = now();
    const until = from + daysAhead * 86_400_000;
    // Ask wide, then filter: the window is ours, not LEARN's.
    const startIso = new Date(from - 86_400_000).toISOString();
    const endIso = new Date(until + 86_400_000).toISOString();

    type Candidate = Omit<DueItem, "dueAtLocal" | "submissionStatus">;

    const fromCalendar = await fanOut(matched, "calendar", async (orgUnitId, course): Promise<Candidate[]> => {
      const events = await api.calendarEvents(orgUnitId, startIso, endIso);
      return effectiveDeadlines(events).map((event) => ({
        type: kindOf(event.AssociatedEntity?.AssociatedEntityType),
        id: String(event.AssociatedEntity?.AssociatedEntityId ?? event.CalendarEventId),
        title: event.Title,
        dueAt: event.StartDateTime,
        courseKey: course.key,
        courseLabel: course.label,
        orgUnitId
      }));
    });

    const fromAssignments = await fanOut(matched, "assignments", async (orgUnitId, course): Promise<Candidate[]> => {
      const folders = await api.assignments<RawAssignment[]>(orgUnitId);
      return folders
        .filter((folder) => folder.IsHidden !== true)
        .flatMap((folder) => {
          const dueAt = folder.DueDate ?? folder.Availability?.EndDate ?? null;
          if (!dueAt) return [];
          return [
            {
              type: "assignment" as const,
              id: String(folder.Id ?? ""),
              title: folder.Name ?? "Untitled assignment",
              dueAt,
              courseKey: course.key,
              courseLabel: course.label,
              orgUnitId
            }
          ];
        });
    });

    const fromQuizzes = await fanOut(matched, "quizzes", async (orgUnitId, course): Promise<Candidate[]> => {
      const payload = await api.quizzes<{ Objects?: RawQuiz[] }>(orgUnitId);
      return (payload.Objects ?? [])
        .filter((quiz) => quiz.IsActive !== false)
        .flatMap((quiz) => {
          const dueAt = quiz.DueDate ?? quiz.EndDate ?? null;
          if (!dueAt) return [];
          return [
            {
              type: "quiz" as const,
              id: String(quiz.QuizId ?? ""),
              title: quiz.Name ?? "Untitled quiz",
              dueAt,
              courseKey: course.key,
              courseLabel: course.label,
              orgUnitId
            }
          ];
        });
    });

    // One deadline can arrive from several sources, and from several org units
    // of one course.
    const seen = new Set<string>();
    const merged = [...fromCalendar.items, ...fromAssignments.items, ...fromQuizzes.items]
      .filter((item) => {
        const at = Date.parse(item.dueAt);
        return Number.isFinite(at) && at >= from && at <= until;
      })
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .filter((item) => {
        const identity = `${item.courseKey}|${item.title}|${new Date(item.dueAt).getTime()}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });

    // Only read the status pages of org units that actually produced a deadline.
    const statuses = new Map<string, Awaited<ReturnType<typeof statusFor>> | null>();
    await Promise.all(
      [...new Set(merged.map((item) => item.orgUnitId))].map(async (orgUnitId) => {
        statuses.set(orgUnitId, await statusFor(orgUnitId).catch(() => null));
      })
    );

    const items: DueItem[] = merged.map((item) => ({
      ...item,
      dueAtLocal: renderLocal(item.dueAt),
      submissionStatus: submissionFor(
        item.type,
        item.title,
        item.id === "" ? undefined : Number(item.id),
        statuses.get(item.orgUnitId) ?? null
      )
    }));

    return {
      status: "ok",
      query: input.courseQuery,
      courses: matched,
      items,
      errors: [...fromCalendar.errors, ...fromAssignments.errors, ...fromQuizzes.errors]
    };
  }

  async function grades(courseQuery?: string): Promise<Result<GradeItem>> {
    const { status, matched } = await resolve(courseQuery);
    if (status === "not_found") return { status, query: courseQuery, courses: [], items: [], errors: [] };

    const { items, errors } = await fanOut(matched, "grades", async (orgUnitId, course) => {
      const values = await api.grades<RawGradeValue[]>(orgUnitId);
      return values.map((value) => ({
        name: value.GradeObjectName ?? "Unnamed item",
        displayedGrade: value.DisplayedGrade ?? null,
        points: pair(value.PointsNumerator, value.PointsDenominator),
        weight: pair(value.WeightedNumerator, value.WeightedDenominator),
        courseKey: course.key,
        courseLabel: course.label,
        orgUnitId
      }));
    });

    return { status: "ok", query: courseQuery, courses: matched, items, errors };
  }

  async function announcements(
    input: { courseQuery?: string; limit?: number } = {}
  ): Promise<Result<Announcement>> {
    const { status, matched } = await resolve(input.courseQuery);
    if (status === "not_found") return { status, query: input.courseQuery, courses: [], items: [], errors: [] };

    const { items, errors } = await fanOut(matched, "announcements", async (orgUnitId, course) => {
      const news = await api.announcements<RawNews[]>(orgUnitId);
      return news
        .filter((entry) => entry.IsHidden !== true)
        .map((entry) => ({
          id: String(entry.Id ?? ""),
          title: entry.Title ?? "Untitled announcement",
          body: entry.Body?.Text ?? "",
          postedAt: entry.StartDate ?? null,
          courseKey: course.key,
          courseLabel: course.label,
          orgUnitId
        }));
    });

    const ordered = items
      .sort((a, b) => Date.parse(b.postedAt ?? "") - Date.parse(a.postedAt ?? ""))
      .slice(0, input.limit ?? 20);

    return { status: "ok", query: input.courseQuery, courses: matched, items: ordered, errors };
  }

  async function content(courseQuery?: string): Promise<Result<CourseTopic>> {
    const { status, matched } = await resolve(courseQuery);
    if (status === "not_found") return { status, query: courseQuery, courses: [], items: [], errors: [] };

    const { items, errors } = await fanOut(matched, "content", async (orgUnitId, course) => {
      const toc = await api.contentToc<{ Modules?: RawModule[] }>(orgUnitId);
      return flattenToc(toc.Modules).map((topic) => ({
        ...topic,
        courseKey: course.key,
        courseLabel: course.label,
        orgUnitId
      }));
    });

    return { status: "ok", query: courseQuery, courses: matched, items, errors };
  }

  async function readTopic(input: {
    topicQuery: string;
    courseQuery?: string;
    maxChars?: number;
  }): Promise<ReadTopicResult> {
    const maxChars = input.maxChars ?? 40_000;
    const listing = await content(input.courseQuery);
    if (listing.status === "not_found") {
      return { status: "not_found", query: input.topicQuery };
    }

    const needle = input.topicQuery.trim().toLowerCase();
    const readable = listing.items.filter((topic) => topic.isFile);

    const exact = readable.filter((topic) => topic.topicId === input.topicQuery.trim());
    const matches = exact.length > 0
      ? exact
      : readable.filter((topic) => topic.title.toLowerCase().includes(needle));

    if (matches.length === 0) return { status: "not_found", query: input.topicQuery };
    if (matches.length > 1) {
      return { status: "ambiguous", query: input.topicQuery, candidates: matches.slice(0, 20) };
    }

    const topic = matches[0];
    const file = await api.fetchFile(topic.url as string);
    const extracted = await extractDocumentText(file.bytes, file.contentType, topic.url as string);
    const truncated = extracted.text.length > maxChars;

    return {
      status: "ok",
      query: input.topicQuery,
      topic,
      text: truncated ? extracted.text.slice(0, maxChars) : extracted.text,
      pages: extracted.pages,
      bytes: file.bytes.byteLength,
      truncated
    };
  }

  return { courses, upcoming, grades, announcements, content, readTopic };
}
