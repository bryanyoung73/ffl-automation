import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { PlayerRef, Position } from "../draft/types.js";

/**
 * Yahoo draft-prep scrapers:
 *   - readPreRank()  : the default pre-rank order from /editprerank
 *   - readAdp()      : average draft position from /draftanalysis
 *
 * Selectors are best guesses. `npm run codegen` against these pages after login,
 * then update SELECTORS. A miss dumps HTML + screenshot to artifacts/.
 */
const SELECTORS = {
  preRankRow: ['ol li:has(a[href*="/players/"])', 'tr:has(a[href*="/players/"])', '[data-tst="prerank-row"]'],
  adpRow: ['tr:has(a[href*="/players/"])', 'table tbody tr'],
  playerLink: ['a[href*="/players/"]'],
  // "KC - WR" style meta line and a bye like "Bye: 10" / "(10)".
  meta: ['[class*="player-status"]', '[class*="ysf-player-detail"]', "td:nth-child(2)"],
} as const;

const POS_RE = /\b(QB|RB|WR|TE|K|DEF|D\/ST)\b/;

export interface PreRankEntry extends PlayerRef {
  rank: number;
}

export class DraftRankingsPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async readPreRank(): Promise<PreRankEntry[]> {
    await this.page.goto(this.config.preRankUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();

    const rows = await this.page
      .evaluate(scrapeRankedList, {
        rowSelectors: SELECTORS.preRankRow as unknown as string[],
        linkSelectors: SELECTORS.playerLink as unknown as string[],
        metaSelectors: SELECTORS.meta as unknown as string[],
      })
      .catch(() => [] as ScrapedRow[]);

    if (rows.length === 0) {
      const base = await this.dumpDebug("prerank-empty");
      throw new Error(
        `Read 0 rows from the pre-rank page. Update DraftRankingsPage SELECTORS.\n` +
          `Debug dump: ${base}.{html,png}`,
      );
    }

    return rows.map((r, i) => ({ ...toPlayerRef(r, i), rank: i + 1 }));
  }

  /** Map of Yahoo player id -> ADP. Players without an ADP are omitted. */
  async readAdp(): Promise<Map<string, number>> {
    await this.page.goto(this.config.draftAnalysisUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();

    const rows = await this.page
      .evaluate(scrapeAdp, {
        rowSelectors: SELECTORS.adpRow as unknown as string[],
        linkSelectors: SELECTORS.playerLink as unknown as string[],
      })
      .catch(() => [] as { id: string; adp: number }[]);

    const map = new Map<string, number>();
    for (const r of rows) if (r.id && Number.isFinite(r.adp)) map.set(r.id, r.adp);

    if (map.size === 0) {
      const base = await this.dumpDebug("adp-empty");
      throw new Error(
        `Read 0 ADP values. Update DraftRankingsPage SELECTORS. Debug dump: ${base}.{html,png}`,
      );
    }
    return map;
  }
}

function toPlayerRef(r: ScrapedRow, i: number): PlayerRef {
  const meta = r.meta.replace(/\s+/g, " ").trim();
  const posMatch = meta.match(POS_RE);
  const position = (posMatch?.[1]?.replace("D/ST", "DEF") ?? "WR") as Position;
  const team = meta.match(/\b([A-Z]{2,3})\b\s*[-–]/)?.[1] ?? meta.split(/[-–]/)[0]?.trim() ?? "";
  const bye = intOrNull(meta.match(/bye[:\s]*?(\d{1,2})/i)?.[1] ?? meta.match(/\((\d{1,2})\)/)?.[1]);
  return {
    id: r.id || `${r.name}|${team}` || `row-${i}`,
    name: r.name.trim(),
    position,
    team: team.toUpperCase(),
    bye,
  };
}

function intOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/* ---- run in browser ---- */
interface RankArgs {
  rowSelectors: string[];
  linkSelectors: string[];
  metaSelectors: string[];
}
interface ScrapedRow {
  id: string;
  name: string;
  meta: string;
}

function scrapeRankedList(args: RankArgs): ScrapedRow[] {
  const firstMatch = (root: Element, sels: string[]): Element | null => {
    for (const s of sels) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  let rowEls: Element[] = [];
  for (const s of args.rowSelectors) {
    rowEls = Array.from(document.querySelectorAll(s));
    if (rowEls.length > 5) break;
  }
  const out: ScrapedRow[] = [];
  const seen = new Set<string>();
  for (const row of rowEls) {
    const link = firstMatch(row, args.linkSelectors) as HTMLAnchorElement | null;
    if (!link) continue;
    const name = (link.textContent ?? "").trim();
    if (!name) continue;
    const href = link.getAttribute("href") ?? "";
    const id = (href.match(/\/players\/(\d+)/) ?? href.match(/pid=(\d+)/))?.[1] ?? "";
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const metaEl = firstMatch(row, args.metaSelectors);
    out.push({ id, name, meta: (metaEl?.textContent ?? row.textContent ?? "").slice(0, 120) });
  }
  return out;
}

function scrapeAdp(args: { rowSelectors: string[]; linkSelectors: string[] }): {
  id: string;
  adp: number;
}[] {
  let rowEls: Element[] = [];
  for (const s of args.rowSelectors) {
    rowEls = Array.from(document.querySelectorAll(s));
    if (rowEls.length > 5) break;
  }
  const out: { id: string; adp: number }[] = [];
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
    const cells = Array.from(row.querySelectorAll("td")).map((c) => (c.textContent ?? "").trim());
    // ADP is usually a decimal like "12.3"; take the first such value in the row.
    const adpText = cells.find((v) => /^\d{1,3}\.\d$/.test(v)) ?? cells.find((v) => /^\d{1,3}$/.test(v));
    const adp = adpText ? Number.parseFloat(adpText) : NaN;
    if (Number.isFinite(adp)) out.push({ id, adp });
  }
  return out;
}
