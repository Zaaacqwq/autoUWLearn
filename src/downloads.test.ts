import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadError, downloadFileName, resolveDownloadDir, saveDownload } from "./downloads.js";

/** A root, a sibling outside it, and cleanup. Real paths, since /tmp is a link on macOS. */
async function sandbox() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autouwlearn-dl-")));
  const root = path.join(base, "course");
  const outside = path.join(base, "elsewhere");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  return { base, root, outside, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

const refusal = (code: string) => (error: unknown) => error instanceof DownloadError && error.code === code;

test("downloads are off until roots are configured, and say how to turn them on", async () => {
  await assert.rejects(
    () => resolveDownloadDir([], "/anywhere"),
    (error: unknown) => refusal("DOWNLOADS_DISABLED")(error) && /LEARN_DOWNLOAD_ROOTS/.test(String((error as DownloadError).action))
  );
});

test("a folder inside a root is created and returned by its real path", async () => {
  const box = await sandbox();
  try {
    const dir = await resolveDownloadDir([box.root], path.join(box.root, "lab2", "starter"));
    assert.equal(dir, path.join(box.root, "lab2", "starter"));
    assert.ok((await fs.stat(dir)).isDirectory());
  } finally {
    await box.cleanup();
  }
});

test("a folder outside every root is refused, however it is spelled", async () => {
  const box = await sandbox();
  try {
    for (const destDir of [box.outside, path.join(box.root, "..", "elsewhere"), path.join(box.root, "../elsewhere/new")]) {
      await assert.rejects(() => resolveDownloadDir([box.root], destDir), refusal("OUTSIDE_DOWNLOAD_ROOTS"), destDir);
    }
    await assert.rejects(() => fs.stat(path.join(box.outside, "new")), "nothing was created outside");
  } finally {
    await box.cleanup();
  }
});

test("a symlink inside a root cannot carry a download out of it", async () => {
  const box = await sandbox();
  try {
    await fs.symlink(box.outside, path.join(box.root, "escape"));
    await assert.rejects(() => resolveDownloadDir([box.root], path.join(box.root, "escape")), refusal("OUTSIDE_DOWNLOAD_ROOTS"));
    await assert.rejects(
      () => resolveDownloadDir([box.root], path.join(box.root, "escape", "deeper")),
      refusal("OUTSIDE_DOWNLOAD_ROOTS")
    );
  } finally {
    await box.cleanup();
  }
});

test("a relative destination is refused rather than resolved against the server's cwd", async () => {
  const box = await sandbox();
  try {
    await assert.rejects(() => resolveDownloadDir([box.root], "lab2"), refusal("INVALID_ARGUMENTS"));
  } finally {
    await box.cleanup();
  }
});

test("file names keep only their last segment and lose anything unsafe", () => {
  assert.equal(downloadFileName("lab2_starter_code.zip"), "lab2_starter_code.zip");
  assert.equal(downloadFileName("../../etc/passwd"), "passwd");
  assert.equal(downloadFileName("..\\..\\boot.ini"), "boot.ini");
  assert.equal(downloadFileName(".zshrc"), "_zshrc", "never a hidden file");
  assert.equal(downloadFileName(".."), "__");
  assert.equal(downloadFileName("a:b|c?.pdf"), "a_b_c_.pdf");
  assert.equal(downloadFileName(""), "download");
});

test("an existing file is kept unless overwrite is asked for", async () => {
  const box = await sandbox();
  try {
    const target = path.join(box.root, "spec.pdf");
    await fs.writeFile(target, "mine");

    await assert.rejects(() => saveDownload(box.root, "spec.pdf", new Uint8Array([1])), refusal("FILE_EXISTS"));
    assert.equal(await fs.readFile(target, "utf8"), "mine");

    await saveDownload(box.root, "spec.pdf", new TextEncoder().encode("theirs"), { overwrite: true });
    assert.equal(await fs.readFile(target, "utf8"), "theirs");
    assert.deepEqual(await fs.readdir(box.root), ["spec.pdf"], "no temporary file is left behind");
  } finally {
    await box.cleanup();
  }
});

test("a new file is written whole", async () => {
  const box = await sandbox();
  try {
    const written = await saveDownload(box.root, "a.zip", new Uint8Array([1, 2, 3]));
    assert.equal(written, path.join(box.root, "a.zip"));
    assert.deepEqual([...(await fs.readFile(written))], [1, 2, 3]);
    assert.deepEqual(await fs.readdir(box.root), ["a.zip"]);
  } finally {
    await box.cleanup();
  }
});
