import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";
import { loadConfig, type Config } from "../config.js";

/**
 * Save a logged-in Yahoo session to STORAGE_STATE_PATH so every other command
 * runs already authenticated. Re-run when a command reports the session expired.
 *
 * Two modes, tried in order:
 *
 *   1. CDP attach (preferred). If a Chrome is listening on CDP_PORT (start it
 *      with `npm run login:chrome`), attach to it, wait until you've reached the
 *      team page, and copy the session out. Google trusts this browser because
 *      Playwright didn't launch it with automation flags.
 *
 *   2. Fallback: launch Playwright's bundled Chromium headed. Works for a plain
 *      Yahoo email+password login, but Google OAuth will likely show
 *      "this browser may not be secure" — use mode 1 for Google sign-in.
 */
const PORT = Number(process.env.CDP_PORT ?? 9222);
const TEAM_URL_RE = /football\.fantasysports\.yahoo\.com\/f1\//;

async function main(): Promise<void> {
  const config = loadConfig();
  const viaCdp = await tryAttachViaCdp(config);
  if (viaCdp) {
    await captureFromContext(viaCdp.context, config, { closeContext: false });
    console.log("You can close the Chrome window now.");
    process.exit(0);
  }

  console.log(
    [
      "",
      "No CDP Chrome found on port " + PORT + ".",
      "For Google sign-in, cancel (Ctrl+C), run `npm run login:chrome`, then rerun this.",
      "",
      "Falling back to a bundled browser (fine for a Yahoo password login):",
      "  1. Sign in to Yahoo.",
      "  2. Wait until your team page loads.",
      "  3. Return here and press Enter.",
      "",
    ].join("\n"),
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(config.teamUrl, { waitUntil: "domcontentloaded" });

  const autoDetect = page
    .waitForURL(TEAM_URL_RE, { timeout: 5 * 60_000 })
    .then(() => "auto" as const)
    .catch(() => "timeout" as const);
  const manual = new Promise<"manual">((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve("manual"));
  });
  const how = await Promise.race([autoDetect, manual]);
  if (how === "timeout") console.warn("Auto-detect timed out; saving current session.");

  await captureFromContext(context, config, { closeContext: true });
  await browser.close();
  process.exit(0);
}

async function tryAttachViaCdp(
  config: Config,
): Promise<{ context: BrowserContext } | null> {
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    console.log(`Attached to Chrome on port ${PORT}.`);

    const onTeamPage = context
      .pages()
      .some((p) => TEAM_URL_RE.test(p.url()));
    if (!onTeamPage) {
      console.log("Waiting for you to reach your Yahoo team page in that window...");
      await waitForTeamPage(context);
    }
    console.log("Team page detected.");
    void config;
    return { context };
  } catch {
    return null;
  }
}

async function waitForTeamPage(context: BrowserContext): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (TEAM_URL_RE.test(page.url())) return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for the Yahoo team page.");
}

async function captureFromContext(
  context: BrowserContext,
  config: Config,
  opts: { closeContext: boolean },
): Promise<void> {
  mkdirSync(dirname(config.storageStatePath), { recursive: true });
  await context.storageState({ path: config.storageStatePath });
  console.log(`\nSaved login session to ${config.storageStatePath}`);
  if (opts.closeContext) await context.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
