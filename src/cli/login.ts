import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { loadConfig } from "../config.js";

/**
 * One-time interactive login. Opens a real browser, waits for you to sign in
 * to Yahoo (via Google, 2FA, "remember me" — all by hand), then saves the
 * session to STORAGE_STATE_PATH so every other command runs already logged in.
 *
 * Re-run this whenever a command reports the session expired (every few weeks).
 */
async function main(): Promise<void> {
  const config = loadConfig();

  console.log(
    [
      "",
      "Opening a browser. Steps:",
      "  1. Click through to sign in to Yahoo with Google.",
      "  2. Complete any 2FA / device prompts.",
      "  3. Wait until your fantasy team page loads.",
      "  4. Come back here and press Enter.",
      "",
    ].join("\n"),
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(config.teamUrl, { waitUntil: "domcontentloaded" });

  // Best-effort auto-detect: resolve as soon as we're back on a fantasy URL.
  const autoDetect = page
    .waitForURL(/football\.fantasysports\.yahoo\.com\/f1\//, { timeout: 5 * 60_000 })
    .then(() => "auto" as const)
    .catch(() => "timeout" as const);

  const manual = new Promise<"manual">((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve("manual"));
  });

  const how = await Promise.race([autoDetect, manual]);
  if (how === "timeout") {
    console.warn("Auto-detect timed out; saving whatever session exists now.");
  }

  mkdirSync(dirname(config.storageStatePath), { recursive: true });
  await context.storageState({ path: config.storageStatePath });
  console.log(`\nSaved login session to ${config.storageStatePath}`);

  await context.close();
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
