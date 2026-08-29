import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Config } from "../config.js";

/**
 * Thin wrapper for "is this session still logged in?" checks and shared
 * debugging helpers. Yahoo redirects unauthenticated requests to login.yahoo.com.
 */
export class TeamPage {
  constructor(
    protected readonly page: Page,
    protected readonly config: Config,
  ) {}

  async goto(): Promise<void> {
    await this.page.goto(this.config.teamUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();
  }

  async assertLoggedIn(): Promise<void> {
    const url = this.page.url();
    if (/login\.yahoo\.com|\/account\/challenge|\/login/.test(url)) {
      throw new Error(
        "Session is not authenticated (redirected to Yahoo login).\n" +
          "Run `npm run login` to refresh the saved session.",
      );
    }
    // A logged-in fantasy page always shows the team nav. Give it a moment.
    const signedOut = this.page.getByRole("link", { name: /sign in/i });
    if (await signedOut.first().isVisible().catch(() => false)) {
      throw new Error("Session expired — run `npm run login` again.");
    }
  }

  /** Save page HTML + screenshot to output/ for selector debugging. */
  async dumpDebug(label: string): Promise<string> {
    const dir = this.config.outputDir;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = resolve(dir, `${label}-${stamp}`);
    await writeFile(`${base}.html`, await this.page.content(), "utf8");
    await this.page.screenshot({ path: `${base}.png`, fullPage: true });
    return base;
  }
}
