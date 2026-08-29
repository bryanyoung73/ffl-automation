import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Config } from "./config.js";

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Open a browser context using the saved login session.
 * Throws a friendly error if no session file exists yet.
 */
export async function openSession(config: Config, overrides?: { headless?: boolean }): Promise<Session> {
  if (!existsSync(config.storageStatePath)) {
    throw new Error(
      `No saved login session at ${config.storageStatePath}.\n` +
        `Run \`npm run login\` once to sign in, then retry.`,
    );
  }

  const browser = await chromium.launch({
    headless: overrides?.headless ?? config.headless,
  });
  const context = await browser.newContext({
    storageState: config.storageStatePath,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
