import assert from "node:assert/strict";
import test from "node:test";
import { parseDropboxList, parseQuizList, stripFolderPrefix } from "./submissionStatus.js";

/* Markup mirrors the live pages: section headers are <th> rows, an unattempted
   quiz has an empty evaluation cell and therefore no quiz id link, and the
   dropbox folder name sits in a <th>. */

const quizHtml = `
<table class="d2l-table d2l-grid d_gl">
  <tr><th>Current Quizzes</th><th>Evaluation Status</th><th>Attempts</th></tr>
  <tr>
    <td><a href="javascript://">Prelab4</a> Due on Jul 13, 2026 8:00 AM</td>
    <td><a href="/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=700001&amp;ou=900001">Feedback: On Attempt</a></td>
    <td>1 / 1</td>
  </tr>
  <tr><th>Future Quizzes</th><th>Evaluation Status</th><th>Attempts</th></tr>
  <tr>
    <td><a href="javascript://">Prelab5</a> Due on Jul 27, 2026 8:00 AM</td>
    <td></td>
    <td>0 / 1</td>
  </tr>
  <tr><th>Past Quizzes</th><th>Evaluation Status</th><th>Attempts</th></tr>
  <tr>
    <td><a href="javascript://">Prelab2</a> Due on Jun 8, 2026 8:00 AM</td>
    <td><a href="/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=700002&amp;ou=900001">Feedback: On Attempt</a></td>
    <td>1 / 1</td>
  </tr>
</table>`;

const dropboxHtml = `
<table class="d2l-table d2l-grid d_gd">
  <tr><th>Folder</th><th>Completion Status</th><th>Score</th><th>Evaluation Status</th></tr>
  <tr><td>LAB 1</td></tr>
  <tr>
    <th><a href="/d2l/lms/dropbox/user/folder_submit_files.d2l?db=800001">Lab 1 - 205</a> Due on May 22, 2026 12:00 PM</th>
    <td><a href="/d2l/lms/dropbox/user/folders_history.d2l?db=800001&amp;grpid=12">1 Submission, 8 Files</a></td>
    <td>- / -</td>
    <td></td>
  </tr>
  <tr><td>LAB 5</td></tr>
  <tr>
    <th><a href="/d2l/lms/dropbox/user/folder_submit_files.d2l?db=800002">Lab 5 - 205</a> Due on Jul 20, 2026 12:00 PM</th>
    <td>Not Submitted</td>
    <td>- / -</td>
    <td></td>
  </tr>
  <tr>
    <th><a href="/d2l/lms/dropbox/user/folder_submit_files.d2l?db=406030">Lab1.Post-lab.205</a></th>
    <td><a href="/d2l/lms/dropbox/user/folders_history.d2l?db=406030">2 Submissions, 2 Files</a></td>
    <td>- / 100</td>
    <td>Feedback: Unread</td>
  </tr>
</table>`;

test("reads quiz attempts and marks an unattempted quiz not_submitted", () => {
  const quizzes = parseQuizList(quizHtml);
  assert.deepEqual(quizzes.map((q) => q.name), ["Prelab4", "Prelab5", "Prelab2"]);

  const prelab5 = quizzes.find((q) => q.name === "Prelab5");
  assert.equal(prelab5?.attemptsUsed, 0);
  assert.equal(prelab5?.attemptsAllowed, 1);
  assert.equal(prelab5?.state, "not_submitted");
});

test("an attempted quiz is submitted", () => {
  const prelab4 = parseQuizList(quizHtml).find((q) => q.name === "Prelab4");
  assert.equal(prelab4?.attemptsUsed, 1);
  assert.equal(prelab4?.state, "submitted");
  assert.equal(prelab4?.evaluation, "Feedback: On Attempt");
});

test("captures the quiz id from the submissions link when present", () => {
  const quizzes = parseQuizList(quizHtml);
  assert.equal(quizzes.find((q) => q.name === "Prelab4")?.quizId, "700001");
  assert.equal(quizzes.find((q) => q.name === "Prelab5")?.quizId, null);
});

test("a submitted quiz can still have no id, so id is never the join key", () => {
  // Live data: ECE 327's "Lab3 Quiz" is submitted 1/1 yet links to no feedback
  // page. Whether an id exists depends on the instructor's feedback settings,
  // not on whether the quiz was attempted.
  const html = quizHtml.replace(
    '<td><a href="/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=700001&amp;ou=900001">Feedback: On Attempt</a></td>',
    "<td></td>"
  );
  const prelab4 = parseQuizList(html).find((q) => q.name === "Prelab4");
  assert.equal(prelab4?.state, "submitted");
  assert.equal(prelab4?.attemptsUsed, 1);
  assert.equal(prelab4?.quizId, null);
});

test("strips the category or lab-group prefix LEARN prepends to folder names", () => {
  assert.equal(stripFolderPrefix("205. 6: Lab1.Post-lab.205"), "Lab1.Post-lab.205");
  assert.equal(stripFolderPrefix("Lab Group 205 - 6: Lab 5 - 205"), "Lab 5 - 205");
  assert.equal(stripFolderPrefix("Oral Assignment Dropbox"), "Oral Assignment Dropbox");
});

test("folders expose the bare name for joining against the Valence API", () => {
  const folders = parseDropboxList(dropboxHtml);
  assert.equal(folders.find((f) => f.folderId === "800001")?.shortName, "Lab 1 - 205");
  assert.equal(folders.find((f) => f.folderId === "406030")?.shortName, "Lab1.Post-lab.205");
});

test("section header rows are not mistaken for quizzes", () => {
  const names = parseQuizList(quizHtml).map((q) => q.name);
  for (const header of ["Current Quizzes", "Future Quizzes", "Past Quizzes"]) {
    assert.ok(!names.includes(header));
  }
});

test("reads assignment submission counts", () => {
  const folders = parseDropboxList(dropboxHtml);
  const lab1 = folders.find((f) => f.name === "Lab 1 - 205");
  assert.equal(lab1?.submissionCount, 1);
  assert.equal(lab1?.state, "submitted");
  assert.equal(lab1?.folderId, "800001");
});

test("Not Submitted is recognised verbatim", () => {
  const lab5 = parseDropboxList(dropboxHtml).find((f) => f.name === "Lab 5 - 205");
  assert.equal(lab5?.state, "not_submitted");
  assert.equal(lab5?.submissionCount, 0);
  assert.equal(lab5?.folderId, "800002");
});

test("plural submissions parse, and feedback state is kept", () => {
  const post = parseDropboxList(dropboxHtml).find((f) => f.name === "Lab1.Post-lab.205");
  assert.equal(post?.submissionCount, 2);
  assert.equal(post?.state, "submitted");
  assert.equal(post?.evaluation, "Feedback: Unread");
});

test("category rows without a folder are skipped", () => {
  const names = parseDropboxList(dropboxHtml).map((f) => f.name);
  assert.ok(!names.includes("LAB 1"));
  assert.equal(names.length, 3);
});

test("empty or unrecognised markup yields nothing rather than throwing", () => {
  assert.deepEqual(parseQuizList("<html><body>nope</body></html>"), []);
  assert.deepEqual(parseDropboxList(""), []);
});
