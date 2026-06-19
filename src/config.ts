import path from "node:path";
import os from "node:os";

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const config = {
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
  navigationTimeoutMs: Number(process.env.LEARN_NAVIGATION_TIMEOUT_MS ?? 30_000)
};

export function absoluteLearnUrl(input: string): string {
  return new URL(input, config.learnBaseUrl).toString();
}
