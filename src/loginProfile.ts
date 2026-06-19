import fs from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { config } from "./config.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStatus(page: Page): Promise<{
  authenticated: boolean;
  url: string;
  title: string;
}> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const loginLike =
    /\/adfs\/|login|signin|saml/i.test(url) ||
    /\b(sign in|username|password|multi-factor authentication|verification code)\b/i.test(bodyText);
  return {
    authenticated: !loginLike && /\/d2l\//i.test(url),
    url,
    title
  };
}

async function main() {
  await fs.mkdir(config.profileDir, { recursive: true });
  await fs.mkdir(config.downloadDir, { recursive: true });

  console.log(`Opening LEARN login with persistent profile: ${config.profileDir}`);
  console.log("Complete Waterloo SSO/MFA in the browser window.");
  console.log("If Waterloo offers “remember me”, “stay signed in”, or Duo “remember this device”, enable it.");

  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    acceptDownloads: true,
    downloadsPath: config.downloadDir
  });
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  context.setDefaultTimeout(config.navigationTimeoutMs);

  const page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
  await page.goto(new URL("/d2l/home", config.learnBaseUrl).toString(), {
    waitUntil: "domcontentloaded"
  });

  let lastStatusLine = "";
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await getStatus(page);
    const statusLine = `${status.authenticated ? "authenticated" : "waiting"} | ${status.title} | ${status.url}`;
    if (statusLine !== lastStatusLine) {
      console.log(statusLine);
      lastStatusLine = statusLine;
    }

    if (status.authenticated) {
      console.log("LEARN login detected. Saving browser profile and closing login browser...");
      await sleep(3000);
      await context.close();
      console.log("Done. The MCP server can now use this profile headlessly.");
      return;
    }

    await sleep(2000);
  }

  await context.close();
  throw new Error("Timed out waiting for LEARN login after 10 minutes.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
