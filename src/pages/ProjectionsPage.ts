import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";

/**
 * Scrape Yahoo's season projected fantasy points from the league players list,
 * paging through results. The URL in config pins the season-projected stat
 * filter (S_PS_<year>) sorted by points; adjust the year in config.projectionsUrl
 * each season.
 *
 * Returns { playerId -> projectedPoints }. Selectors are best guesses.
 */
const SELECTORS = {
  playerRow: ['tr:has(a[href*="/players/"])'],
  playerLink: ['a[href*="/players/"]'],
  nextPage: ['a:has-text("Next")', 'a[rel="next"]', 'a[href*="&count="]:has-text("Next")'],
} as const;

const MAX_PAGES = 12;

export class ProjectionsPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async read(): Promise<Map<string, number>> {
    await this.page.goto(this.config.projectionsUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();

    const points = new Map<string, number>();
    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      const rows = await this.page
        .evaluate(scrapeProjections, {
          rowSelectors: SELECTORS.playerRow as unknown as string[],
          linkSelectors: SELECTORS.playerLink as unknown as string[],
        })
        .catch(() => [] as { id: string; proj: number }[]);

      for (const r of rows) {
        if (r.id && Number.isFinite(r.proj) && !points.has(r.id)) points.set(r.id, r.proj);
      }

      const next = this.firstVisible(SELECTORS.nextPage);
      if (!(await next)) break;
      await (await next)!.click();
      await this.page.waitForLoadState("domcontentloaded");
    }

    if (points.size === 0) {
      const base = await this.dumpDebug("projections-empty");
      throw new Error(
        `Read 0 projections. Update ProjectionsPage SELECTORS / config.projectionsUrl.\n` +
          `Debug dump: ${base}.{html,png}`,
      );
    }
    return points;
  }

  private async firstVisible(selectors: readonly string[]) {
    for (const sel of selectors) {
      const el = this.page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    return null;
  }
}

function scrapeProjections(args: { rowSelectors: string[]; linkSelectors: string[] }): {
  id: string;
  proj: number;
}[] {
  let rowEls: Element[] = [];
  for (const s of args.rowSelectors) {
    rowEls = Array.from(document.querySelectorAll(s));
    if (rowEls.length > 3) break;
  }
  const out: { id: string; proj: number }[] = [];
  for (const row of rowEls) {
    let link: HTMLAnchorElement | null = null;
    for (const s of args.linkSelectors) {
      link = row.querySelector(s);
      if (link) break;
    }
    if (!link) continue;
    const href = link.getAttribute("href") ?? "";
    const id = (href.match(/\/players\/(\d+)/) ?? href.match(/pid=(\d+)/))?.[1] ?? "";
    if (!id) continue;
    const nums = Array.from(row.querySelectorAll("td"))
      .map((c) => Number.parseFloat((c.textContent ?? "").trim()))
      .filter((n) => Number.isFinite(n));
    // Season projection is the largest number in the row (points >> other stats).
    const proj = nums.length ? Math.max(...nums) : NaN;
    if (Number.isFinite(proj)) out.push({ id, proj });
  }
  return out;
}
