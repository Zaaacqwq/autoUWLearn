import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Larger than any handout or starter archive; small enough not to fill a disk by accident. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export type DownloadErrorCode =
  | "DOWNLOADS_DISABLED"
  | "OUTSIDE_DOWNLOAD_ROOTS"
  | "FILE_EXISTS"
  | "NOT_A_FILE"
  | "INVALID_ARGUMENTS";

/** A download refused before or instead of writing anything. */
export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly action?: string;

  constructor(code: DownloadErrorCode, message: string, action?: string) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.action = action;
  }
}

const within = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

const exists = async (target: string): Promise<boolean> =>
  fs.lstat(target).then(
    () => true,
    () => false
  );

/** The configured roots that exist, by their real path. Relative entries are ignored: relative to what? */
async function realRoots(roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(
    roots.filter((root) => path.isAbsolute(root)).map((root) => fs.realpath(root).catch(() => null))
  );
  return real.filter((root): root is string => root !== null);
}

/**
 * Resolves `destDir` to a real folder inside one of `roots`, creating it if
 * needed.
 *
 * Compared by real path, so neither `..` nor a symlink inside a root can walk
 * a write out of it. The check runs again after creating the folder, because a
 * link could have been swapped in between.
 */
export async function resolveDownloadDir(roots: readonly string[], destDir: string): Promise<string> {
  if (roots.length === 0) {
    throw new DownloadError(
      "DOWNLOADS_DISABLED",
      "Downloads are disabled on this server.",
      "Set LEARN_DOWNLOAD_ROOTS to the folders downloads may be written into, then restart the server."
    );
  }
  const allowed = await realRoots(roots);
  if (allowed.length === 0) {
    throw new DownloadError(
      "DOWNLOADS_DISABLED",
      "None of the folders in LEARN_DOWNLOAD_ROOTS exists as an absolute path.",
      "Point LEARN_DOWNLOAD_ROOTS at existing folders."
    );
  }
  if (!path.isAbsolute(destDir)) {
    throw new DownloadError("INVALID_ARGUMENTS", `destDir must be an absolute path, not "${destDir}".`);
  }
  const outside = (): DownloadError =>
    new DownloadError(
      "OUTSIDE_DOWNLOAD_ROOTS",
      `${destDir} is outside the folders downloads may be written into.`,
      `Choose a folder inside: ${allowed.join(", ")}`
    );

  // Find the deepest part that already exists and resolve it; what is left to
  // create cannot contain links yet.
  let existing = path.resolve(destDir);
  const missing: string[] = [];
  while (!(await exists(existing))) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const candidate = path.join(await fs.realpath(existing), ...missing);
  if (!allowed.some((root) => within(candidate, root))) throw outside();

  await fs.mkdir(candidate, { recursive: true });
  const real = await fs.realpath(candidate);
  if (!allowed.some((root) => within(real, root))) throw outside();
  if (!(await fs.stat(real)).isDirectory()) {
    throw new DownloadError("NOT_A_FILE", `${destDir} is not a folder.`);
  }
  return real;
}

/**
 * A file name LEARN supplied, made safe to create: the last path segment only,
 * no control or reserved characters, and never hidden or empty.
 */
export function downloadFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim()
    // A leading dot would hide the file, and "." or ".." would name a folder.
    .replace(/^\.+/, (dots) => "_".repeat(dots.length));
  const bounded = cleaned.length > 200 ? cleaned.slice(cleaned.length - 200) : cleaned;
  return bounded === "" ? "download" : bounded;
}

/**
 * Writes `bytes` to `dir/name`.
 *
 * The file is written beside its destination and then moved into place, so
 * nobody ever sees half a file. Without `overwrite` the move is a hard link,
 * which fails if the name was taken in the meantime instead of replacing it.
 */
export async function saveDownload(
  dir: string,
  name: string,
  bytes: Uint8Array,
  options: { overwrite?: boolean } = {}
): Promise<string> {
  const target = path.join(dir, name);
  await refuseExisting(target, options.overwrite === true);

  const temporary = path.join(dir, `.${name}.${process.pid}.${randomUUID()}.part`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    if (options.overwrite) {
      await fs.rename(temporary, target);
    } else {
      await fs.link(temporary, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw existsError(target);
        throw error;
      });
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return target;
}

const existsError = (target: string): DownloadError =>
  new DownloadError("FILE_EXISTS", `${target} already exists.`, "Pass overwrite: true to replace it.");

/** Checked before fetching, so a refused download costs no transfer. */
export async function refuseExisting(target: string, overwrite: boolean): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) throw new DownloadError("NOT_A_FILE", `${target} is a folder.`);
  if (!overwrite) throw existsError(target);
}
