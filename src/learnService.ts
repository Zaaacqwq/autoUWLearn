import { findCourses, mergeOrgUnits, type Course, type OrgUnit } from "./courseIdentity.js";
import type { LearnApi } from "./learnApi.js";

export type ResolutionStatus = "ok" | "not_found";

export interface OrgUnitError {
  readonly orgUnitId: string;
  readonly courseLabel: string;
  readonly source: string;
  readonly error: string;
  readonly message: string;
}

export interface DueItem {
  readonly type: "assignment" | "quiz";
  readonly id: string;
  readonly title: string;
  readonly dueAt: string;
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
}

export interface LearnService {
  courses(): Promise<Course[]>;
  upcoming(options?: { daysAhead?: number; courseQuery?: string }): Promise<Result<DueItem>>;
  grades(courseQuery?: string): Promise<Result<GradeItem>>;
  announcements(options?: { courseQuery?: string; limit?: number }): Promise<Result<Announcement>>;
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

  async function upcoming(input: { daysAhead?: number; courseQuery?: string } = {}): Promise<Result<DueItem>> {
    const daysAhead = input.daysAhead ?? 14;
    const { status, matched } = await resolve(input.courseQuery);
    if (status === "not_found") {
      return { status, query: input.courseQuery, courses: [], items: [], errors: [] };
    }

    const assignments = await fanOut(matched, "assignments", async (orgUnitId, course) => {
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

    const quizzes = await fanOut(matched, "quizzes", async (orgUnitId, course) => {
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

    const from = now();
    const until = from + daysAhead * 86_400_000;

    // Two sections of one course surface the same deadline twice.
    const seen = new Set<string>();
    const items = [...assignments.items, ...quizzes.items]
      .filter((item) => {
        const at = Date.parse(item.dueAt);
        return Number.isFinite(at) && at >= from && at <= until;
      })
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .filter((item) => {
        const identity = `${item.courseKey}|${item.type}|${item.title}|${item.dueAt}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });

    return {
      status: "ok",
      query: input.courseQuery,
      courses: matched,
      items,
      errors: [...assignments.errors, ...quizzes.errors]
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

  return { courses, upcoming, grades, announcements };
}
