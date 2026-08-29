import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";

/**
 * Launch your real, installed Google Chrome with a remote-debugging port and a
 * dedicated profile directory. You then sign in to Yahoo by hand in that window
 * (Google trusts it — it was not started by Playwright with automation flags).
 * Leave it open and run `npm run login` in another terminal to grab the session.
 *
 * The dedicated profile lives in .auth/chrome-profile (gitignored) so it never
 * touches your everyday Chrome and you don't have to close your normal browser.
 */
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

const PORT = Number(process.env.CDP_PORT ?? 9222);

function main(): void {
  const config = loadConfig();
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) {
    console.error(
      "Could not find Chrome. Install Google Chrome, or set the path:\n" +
        "  CDP_CHROME=\"C:\\path\\to\\chrome.exe\" npm run login:chrome",
    );
    process.exit(1);
  }

  const profileDir = resolve(config.projectRoot, ".auth", "chrome-profile");
  mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    config.teamUrl,
  ];

  console.log(
    [
      "",
      `Launching Chrome (${chrome})`,
      `  debug port : ${PORT}`,
      `  profile    : ${profileDir}`,
      "",
      "In that Chrome window:",
      "  1. Sign in to Yahoo with Google (2FA and all).",
      "  2. Wait until your fantasy team page loads.",
      "  3. Leave the window open.",
      "",
      "Then, in another terminal:  npm run login",
      "",
    ].join("\n"),
  );

  const child = spawn(process.env.CDP_CHROME || chrome, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

main();
