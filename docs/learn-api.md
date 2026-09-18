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
| `/d2l/api/le/{le}/{ou}/calendar/events/?startDateTime=&endDateTime=` | Deadlines, incl. ones the two rows above cannot express. See below |

Not usable: `/quizzes/{id}/attempts/` (403), `/dropbox/folders/{id}/submissions/` (403),
`/calendar/events/myEvents/` (400), `/d2l/api/le/unstable/*` (404).

### Calendar events

Both date bounds are required; without them the endpoint returns `200 []`, which
reads like "no events" rather than "you forgot the range". Scoped per org unit.

`EventType` is an enum:

| Value | Meaning | Associated entity |
|---|---|---|
| 1 | Plain event, e.g. a scheduled lab session | none |
| 2 | Availability starts | Quiz, Dropbox |
| 3 | Availability ends | Quiz, Dropbox |
| **6** | **Due** | **ModuleCO, Quiz, Dropbox** |
| 8 | Discussion forum | DiscussionForum |

`AssociatedEntity.AssociatedEntityId` links back to the quiz or dropbox folder,
which is how a deadline gets joined to its submission status.

An entity emits up to three events (2, 6, 3). **The effective deadline is the
`due` event if there is one, otherwise the `availability ends` event.** Filtering
to `EventType === 6` alone loses real deadlines: FR 151's tests carry no due
date and close on availability.

Note that a course's deadlines may live in a different org unit than its
assignments: ECE 380's calendar events are split across both of its org units.

### No single source is complete — take the union

Checked every dated entity in every course against the calendar:

| Course | Calendar events | Result |
|---|---|---|
| ECE 318, ECE 380 | 17, 31 | Calendar covers everything |
| **ECE 327** | **0** | All three quizzes exist only in `quizzes` |
| **FR 151** | 19 | `Test #3` missing; `Assignment 4`-style items missing elsewhere |

- The calendar carries deadlines the others cannot express: a **content module**
  with a due date (`ModuleCO`), living in an org unit whose dropbox folder list
  is empty. `dropbox/folders` and `quizzes` can never surface it.
- `dropbox/folders` and `quizzes` carry deadlines the calendar omits entirely:
  ECE 327's calendar holds **zero** events while all its quizzes are dated.

So `learn_due_dates` unions all three and collapses duplicates on
`(course, title, instant)`. `EventType 8` (discussion) is not currently treated
as a deadline.

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

### Calendar list view — `/d2l/le/calendar/{ou}`

Renders events for **every** enrolled course, not just `{ou}`. Useful for
eyeballing, but do not scrape it: the JSON `calendar/events/` endpoint above
carries the same data, and paging this view issues
`POST /d2l/le/calendar/{ou}/listviewfilter/save`, which mutates server-side
per-user filter state.

## Consequences for this repo

1. `learn_due_dates` read dropbox folders + quizzes, so it **silently missed
   deadlines attached to anything else**. ECE 380 Assignment 4, due Jul 15, is a
   content-module deadline and was absent from the tool's output. Fixed by
   unioning the calendar with the two API sources; sourcing from the calendar
   alone would have lost ECE 327's quizzes instead.
2. Nothing exposes submission status, so "did I submit this?" cannot be answered.
   A model asked it will try to infer from "no grade yet", which is wrong: a
   submitted, ungraded quiz has no grade. Fix: parse the two list pages and join
   on `AssociatedEntity.AssociatedEntityId`.
3. `dueAt` is emitted as a UTC instant with no timezone hint for the model.

Deadlines come from JSON. Only submission status requires HTML, and there it is
stated in plain words (`Not Submitted`, `0 / 1`) rather than inferred, which is
what made the old HTML due-date parsing fragile.

## The session

Two cookies authenticate every read, `d2lSessionVal` and `d2lSecureSessionVal`,
and LEARN rejects either one without the other.

Three things about them decide how long the server stays logged in:

1. **They rotate.** LEARN reissues them mid-session over `Set-Cookie`. A browser
   absorbs that silently; `fetch` does not, having no cookie jar. Reads that
   discard the rotation keep replaying the value from the last interactive
   login, which LEARN eventually stops accepting — so the write-back in
   `sessionCookies.ts` is not an optimisation, it is what makes the saved
   session survive its own use.
2. **The timeout is idle, not absolute.** Brightspace signs out a quiet session
   ("Your session was open without any activity for a while") and offers no
   dedicated keep-alive endpoint; any authenticated request counts, which is
   what the `whoami` heartbeat is for.
3. **Expiry does not always look like 403.** A JSON read answers `302` to the
   identity provider, and a file or HTML read — which follows redirects —
   answers `200` with the Waterloo login page as its body. Both are session
   expiry and both must be classified as such, or they surface as an
   unactionable HTTP error and no recovery is attempted.

Recovery is a headless navigation to `/d2l/home` in the persistent browser
profile. It works because Waterloo's upstream identity session outlives the
Brightspace one and Duo remembers the device for weeks; it fails, and needs a
human, only once that upstream session has gone too.
