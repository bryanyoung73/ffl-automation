import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { PlayerRef, Position } from "../draft/types.js";

/**
 * Scrape Yahoo's Edit Pre-Draft Ranks page (/f1/<league>/<team>/editprerank).
 *
 * That page renders ~300 players, each with Yahoo's expert rank (XRank), ADP,
 * position, team, and bye. One scrape covers everything the cheat sheet needs
 * except projected points (those load only when a row is expanded).
 *
 * Class names on the page are hashed (`_ys_xxxxx`) and change every deploy, so
 * we anchor on stable ARIA hooks instead. Verified against league 891808 on
 * 2026-08-29.
 */
const ROW_ANCHOR = '[aria-controls^="player-projections-"]';

export interface PreRankEntry extends PlayerRef {
  /** Position in the current pre-rank list (1 = first off the board). */
  listRank: number;
  /** Yahoo's published expert rank ("XRank"). Equals listRank until you customize. */
  xRank: number | null;
  /** Average draft position, or null if Yahoo shows none. */
  adp: number | null;
}

export class DraftRankingsPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async readPreRank(): Promise<PreRankEntry[]> {
    await this.page.goto(this.config.preRankUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();
    await this.page.waitForSelector(ROW_ANCHOR, { timeout: 30_000 }).catch(() => undefined);

    const rows = await this.page.evaluate(scrapePreRankRows, ROW_ANCHOR);

    if (rows.length === 0) {
      const base = await this.dumpDebug("prerank-empty");
      throw new Error(
        `Read 0 players from the pre-rank page. The ARIA anchor "${ROW_ANCHOR}" ` +
          `matched nothing — Yahoo may have changed the markup.\n` +
          `Debug dump: ${base}.{html,png}`,
      );
    }

    return rows.map((r, i) => {
      const posMatch = r.meta.match(/\b(QB|RB|WR|TE|K|DEF|D\/ST)\b/);
      const position = (posMatch?.[1]?.replace("D/ST", "DEF") ?? "WR") as Position;
      // meta: "RB · Det · Bye 6"  — team is the token that isn't position/"Bye N"
      const parts = r.meta.split(/[·|•·]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      const team =
        parts.find((p) => /^[A-Za-z]{2,3}$/.test(p) && p.toUpperCase() !== position) ?? "";
      const bye = intOrNull(r.meta.match(/bye\s*(\d{1,2})/i)?.[1]);
      const xRank = intOrNull(r.stats.match(/xrank\s*#?\s*(\d{1,3})/i)?.[1]);
      const adp = floatOrNull(r.stats.match(/adp\s*([\d.]+)/i)?.[1]);

      return {
        id: r.id,
        name: r.name,
        position,
        team: team.toUpperCase(),
        bye,
        listRank: i + 1,
        xRank,
        adp,
      } satisfies PreRankEntry;
    });
  }
}

interface ScrapedPreRankRow {
  id: string;
  name: string;
  meta: string;
  stats: string;
}

/* runs in the browser — keep as a top-level declaration (no nested named fns). */
function scrapePreRankRows(anchor: string): ScrapedPreRankRow[] {
  const out: ScrapedPreRankRow[] = [];
  const seen: Record<string, true> = {};
  const els = Array.from(document.querySelectorAll(anchor));
  for (const el of els) {
    const id =
      el.getAttribute("aria-controls")?.match(/player-projections-(\d+)/)?.[1] ?? "";
    if (!id || seen[id]) continue;
    seen[id] = true;
    const firstSpan = el.querySelector(":scope > span") ?? el.querySelector("span");
    const divs = Array.from(el.querySelectorAll(":scope > div"));
    out.push({
      id,
      name: (firstSpan?.textContent ?? "").replace(/\s+/g, " ").trim(),
      meta: (divs[0]?.textContent ?? "").replace(/\s+/g, " ").trim(),
      stats: (divs[1]?.textContent ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

function intOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}
function floatOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
