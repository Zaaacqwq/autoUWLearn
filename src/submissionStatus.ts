import * as cheerio from "cheerio";

/**
 * Whether the user has handed something in.
 *
 * LEARN states this plainly on its list pages ("Not Submitted", "0 / 1"), which
 * is why these are parsed from HTML rather than inferred. The Valence API has no
 * student-visible equivalent: both quizzes/{id}/attempts/ and
 * dropbox/folders/{id}/submissions/ answer 403 for a student.
 */
export type SubmissionState = "submitted" | "not_submitted" | "unknown";

export interface QuizSubmission {
  readonly name: string;
  /**
   * Only present when the row links to a feedback page, which depends on the
   * instructor's feedback settings and not on whether the quiz was attempted.
   * A submitted quiz can lack one, so join on `name` and treat this as a bonus.
   */
  readonly quizId: string | null;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number;
  readonly state: SubmissionState;
  readonly evaluation: string | null;
}

export interface AssignmentSubmission {
  /** As shown, e.g. "Lab Group 205 - 6: Lab 5 - 205". */
  readonly name: string;
  /** The folder's own name with any category or group prefix removed. */
  readonly shortName: string;
  /** Absent when the row links to no history page. Join on `shortName` instead. */
  readonly folderId: string | null;
  readonly submissionCount: number;
  readonly state: SubmissionState;
  readonly evaluation: string | null;
}

/**
 * LEARN prefixes a folder's displayed name with its category or lab group, e.g.
 * "205. 6: Lab1.Post-lab.205", while the Valence API returns the bare name.
 */
export function stripFolderPrefix(name: string): string {
  const index = name.lastIndexOf(": ");
  return index === -1 ? name : name.slice(index + 2).trim();
}

const clean = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Strips the trailing "Due on …" / "Available on …" blurb from a title cell. */
const titleOf = ($: cheerio.CheerioAPI, cell: cheerio.Cheerio<never>): string => {
  const anchor = cell.find("a").first();
  const raw = anchor.length > 0 ? anchor.text() : cell.text();
  return clean(raw).replace(/\s*(Due on|Available on)\b.*$/i, "").trim();
};

const idFromHref = (href: string | undefined, param: string): string | null => {
  if (!href) return null;
  const match = new RegExp(`[?&]${param}=(\\d+)`).exec(href.replace(/&amp;/g, "&"));
  return match ? match[1] : null;
};

/** `/d2l/lms/quizzing/user/quizzes_list.d2l?ou={ou}` */
export function parseQuizList(html: string): QuizSubmission[] {
  if (!html.trim()) return [];
  const $ = cheerio.load(html);
  const quizzes: QuizSubmission[] = [];

  $("tr").each((_, row) => {
    const cells = $(row).find("td");
    // Section headers ("Current Quizzes") are th-only rows.
    if (cells.length < 3) return;

    const attempts = /^(\d+)\s*\/\s*(\d+)$/.exec(clean($(cells[2]).text()));
    if (!attempts) return;

    const evaluationCell = $(cells[1]);
    const evaluation = clean(evaluationCell.text());
    const name = titleOf($, $(cells[0]) as never);
    if (!name) return;

    const used = Number(attempts[1]);
    quizzes.push({
      name,
      quizId: idFromHref(evaluationCell.find("a").first().attr("href"), "qi"),
      attemptsUsed: used,
      attemptsAllowed: Number(attempts[2]),
      state: used > 0 ? "submitted" : "not_submitted",
      evaluation: evaluation || null
    });
  });

  return quizzes;
}

/** `/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}` */
export function parseDropboxList(html: string): AssignmentSubmission[] {
  if (!html.trim()) return [];
  const $ = cheerio.load(html);
  const folders: AssignmentSubmission[] = [];

  $("tr").each((_, row) => {
    // The folder name lives in a th; category rows carry no th.
    const nameCell = $(row).find("th").first();
    const cells = $(row).find("td");
    if (nameCell.length === 0 || cells.length < 2) return;

    const name = titleOf($, nameCell as never);
    if (!name) return;

    const completionCell = $(cells[0]);
    const completion = clean(completionCell.text());

    const submissions = /^(\d+)\s+Submissions?/i.exec(completion);
    const notSubmitted = /^not submitted$/i.test(completion);
    if (!submissions && !notSubmitted) return;

    folders.push({
      name,
      shortName: stripFolderPrefix(name),
      folderId:
        idFromHref(completionCell.find("a").first().attr("href"), "db") ??
        idFromHref(nameCell.find("a").first().attr("href"), "db"),
      submissionCount: submissions ? Number(submissions[1]) : 0,
      state: submissions ? "submitted" : "not_submitted",
      evaluation: clean($(cells[2] ?? cells[1]).text()) || null
    });
  });

  return folders;
}
