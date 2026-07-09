# UW LEARN data sources

Findings from driving a logged-in browser through LEARN and recording every
request. Recorded 2026-07-09 against Brightspace `20.26.6.24942`.

## The shape of the problem

UW's Brightspace pages are almost entirely **server-rendered**. Loading the quiz
list, the assignment list and the calendar produced **zero XHR calls** to
`/d2l/api/` — only static assets from `s.brightspace.com`. There is no hidden
JSON API behind these screens.

This splits the data cleanly in two:

| | Source | Shape |
|---|---|---|
| **Definitions** — what exists, when it is due, what it is worth | Valence API | JSON |
| **My status** — did I submit, was it graded, is it complete | Server-rendered HTML | HTML |

The Valence API exposes no per-student status. `/quizzes/{id}/attempts/` answers
**403** for a student; it is an instructor endpoint.

## Valence JSON API (definitions)

Works with the session cookies alone. No OAuth registration, no CSRF header on
reads. Versions: `le` 1.95, `lp` 1.61.

| Path | Gives |
|---|---|
| `/d2l/api/versions/` | Supported product versions |
| `/d2l/api/lp/{lp}/users/whoami` | User identifier. Also the cheapest liveness probe for a session |
| `/d2l/le/manageCourses/api/mycourses` | Courses (`Courses[]`, note: not `Items[]`) |
| `/d2l/api/le/{le}/{ou}/grades/values/myGradeValues/` | Released grades, incl. `GradeObjectName` |
| `/d2l/api/le/{le}/{ou}/grades/` | Grade objects. **No due dates** |
| `/d2l/api/le/{le}/{ou}/dropbox/folders/` | Assignment folders + `DueDate` |
| `/d2l/api/le/{le}/{ou}/quizzes/` | Quizzes + `DueDate`, `AttemptsAllowed` |
| `/d2l/api/le/{le}/{ou}/news/` | Announcements incl. body |
| `/d2l/api/le/{le}/{ou}/content/toc` | Content tree |
| `/content/enforced/...` | Course files (PDF etc.) |

Not usable: `/quizzes/{id}/attempts/` (403), `/calendar/events/myEvents/` (400/404),
`/d2l/api/le/unstable/*` (404).

## Server-rendered pages (status)

### Quiz attempts — `/d2l/lms/quizzing/user/quizzes_list.d2l?ou={ou}`

One request per org unit returns every quiz with an attempts count. Grouped into
`Current Quizzes` / `Future Quizzes` / `Past Quizzes`.

```
Lab3 Quiz     Available on Jul 6 … until Jul 9, 2026 11:30 AM      1 / 1
Prelab5       Due on Jul 27 …                                      0 / 1
Lab1 Quiz     …                     Feedback: On Attempt           1 / 1
```

`N / M` is attempts-used / attempts-allowed. **`0 / M` means not attempted.**
A submitted-but-ungraded quiz shows an attempt and `Pending Evaluation` on its
submissions page.

### Assignment submissions — `/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}`

Columns: `Folder | Completion Status | Score | Evaluation Status`.

```
Lab 4 - 205    Due Jul 6      1 Submission, 6 Files    - / -
Lab 5 - 205    Due Jul 20     Not Submitted            - / -
Lab1.Post-lab  Due May 26     2 Submissions, 2 Files    - / 100   Feedback: Unread
```

**`Not Submitted`** is an explicit string. Otherwise `N Submission(s), M File(s)`.

### Per-quiz detail — `/d2l/lms/quizzing/user/quiz_submissions.d2l?qi={quizId}&ou={ou}`

Shows `Attempt 1 — <score>` or `Attempt 1 — Pending Evaluation`, and a
"have not taken" phrase when unattempted. Only needed when the per-attempt score
matters; the list page above is cheaper.

### Calendar — `/d2l/le/calendar/{ou}`

**Returns events for every enrolled course, not just `{ou}`.** One request covers
everything. Event types: Dropbox, Checklists, Discussions, Events, Grades,
Materials, Modules, Quizzes, Surveys.

This is the **only complete source of due dates**. It carries deadlines the
Valence API does not expose at all:

- `Assignment 4 - Due — ECE 380 — Jul 15, 2026 11:59 PM` exists in no dropbox
  folder and no quiz in either ECE 380 org unit. It is a grade item with a due
  date, and grade objects carry no date field.
- Class and lab sessions: `ECE 380 Lab — Jul 9, 8:00 AM - 12:00 PM`.
- Late dropboxes as separate items: `Oral Assignment (LATE) Dropbox`.

It also distinguishes `X - Due` from `X - Availability Ends`, which the current
code conflates by falling back from `DueDate` to `Availability.EndDate`.

Open question: how to bound the calendar's date range. The list view paginates
with Previous/Next; the range parameters were not captured.

## Consequences for this repo

1. `learn_due_dates` reads dropbox folders + quizzes, so it **silently misses
   grade-item deadlines**. Verified: ECE 380 Assignment 4, due Jul 15, absent
   from the tool's output.
2. Nothing exposes submission status, so "did I submit this?" cannot be answered.
   A model asked it will try to infer from "no grade yet", which is wrong: a
   submitted, ungraded quiz has no grade.
3. `dueAt` is emitted as a UTC instant with no timezone hint for the model.
