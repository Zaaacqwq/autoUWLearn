import path from "node:path";
import os from "node:os";

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Which tools a server registers. `agent` is for unattended clients — Swarm
 * spawns one stdio server per agent run — and leaves out the login tools.
 */
export type Toolset = "all" | "agent";

function toolsetEnv(value: string | undefined): Toolset {
  if (value == null || value === "") return "all";
  if (value === "all" || value === "agent") return value;
  // A typo must not quietly hand an agent the login tools.
  throw new Error(`LEARN_MCP_TOOLSET must be "all" or "agent", not "${value}".`);
}

/** Folders learn_download may write into, separated like PATH. None: downloads are off. */
function pathListEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export const config = {
  toolset: toolsetEnv(process.env.LEARN_MCP_TOOLSET),
  downloadRoots: pathListEnv(process.env.LEARN_DOWNLOAD_ROOTS),
  learnBaseUrl: process.env.LEARN_BASE_URL ?? "https://learn.uwaterloo.ca",
  authUrl: process.env.LEARN_AUTH_URL ?? "http://127.0.0.1:8787/auth",
  profileDir:
    process.env.LEARN_PROFILE_DIR ??
    path.resolve(os.homedir(), ".uwlearn-mcp", "playwright-profile"),
  storageStatePath:
    process.env.LEARN_STORAGE_STATE_PATH ??
    path.resolve(os.homedir(), ".uwlearn-mcp", "storage-state.json"),
  oauthTokenStorePath:
    process.env.LEARN_OAUTH_TOKEN_STORE_PATH ??
    path.resolve(os.homedir(), ".uwlearn-mcp", "oauth-tokens.json"),
  downloadDir:
    process.env.LEARN_DOWNLOAD_DIR ??
    path.resolve(os.homedir(), ".uwlearn-mcp", "downloads"),
  headless: boolEnv(process.env.LEARN_HEADLESS, false),
  navigationTimeoutMs: Number(process.env.LEARN_NAVIGATION_TIMEOUT_MS ?? 30_000),
  /** A session check must answer quickly or admit it cannot; it never retries. */
  sessionProbeTimeoutMs: Number(process.env.LEARN_SESSION_PROBE_TIMEOUT_MS ?? 5_000)
};

export function absoluteLearnUrl(input: string): string {
  return new URL(input, config.learnBaseUrl).toString();
}
