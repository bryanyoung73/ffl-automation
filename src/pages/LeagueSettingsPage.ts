import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { LeagueSettings, SlotCode } from "../draft/types.js";

/**
 * Scrape roster + scoring from /f1/<league>/settings.
 *
 * The settings page is a long definition list / table of "Label: Value" rows.
 * We read it as text and pattern-match, which is more robust to layout changes
 * than positional selectors. Verify against the real page after login; if a
 * field can't be found the caller gets a clear error + artifacts/ dump.
 */
const SLOT_LABELS: Record<string, SlotCode> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  DEF: "DEF",
  "W/R/T": "W/R/T",
  "W/R": "W/R/T",
  FLEX: "W/R/T",
};

export class LeagueSettingsPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async read(): Promise<LeagueSettings> {
    await this.page.goto(this.config.leagueSettingsUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();

    const text = await this.page.evaluate(() => {
      const root =
        (document.querySelector("#settings-content") as HTMLElement | null) ?? document.body;
      return (root.innerText ?? root.textContent ?? "").replace(/\r/g, "");
    });

    const teams = matchInt(text, /Number of Teams\s*:?\s*(\d+)/i) ?? matchInt(text, /(\d+)\s*Team\b/i);
    const scoringRaw = matchStr(text, /Scoring Type\s*:?\s*([A-Za-z0-9 .()-]+)/i) ?? "";
    const draftRaw = matchStr(text, /Draft Type\s*:?\s*([A-Za-z ]+)/i) ?? "";

    const starters = parseRoster(text);
    const benchSize = matchInt(text, /\bBN\s*[·:]?\s*(\d+)/i) ?? matchInt(text, /Bench\s*:?\s*(\d+)/i) ?? 6;

    if (!teams || Object.keys(starters).length === 0) {
      const base = await this.dumpDebug("league-settings-parse");
      throw new Error(
        `Could not parse league settings (teams=${teams}, starters=${JSON.stringify(starters)}).\n` +
          `Update LeagueSettingsPage selectors/regex. Debug dump: ${base}.{html,png}`,
      );
    }

    return {
      teams,
      scoring: normalizeScoring(scoringRaw),
      starters,
      benchSize,
      draftType: /auction/i.test(draftRaw) ? "auction" : "snake",
    };
  }
}

function parseRoster(text: string): LeagueSettings["starters"] {
  // Yahoo lists roster positions like: "QB, WR, WR, RB, RB, TE, W/R/T, K, DEF, BN, BN, ..."
  const line =
    matchStr(text, /Roster Positions\s*:?\s*([A-Z/,\s\d()·]+)/i) ??
    matchStr(text, /Starting Lineup\s*:?\s*([A-Z/,\s\d()·]+)/i);
  const starters: LeagueSettings["starters"] = {};
  if (!line) return starters;

  for (const token of line.split(/[,·\n]/)) {
    const label = token.trim().toUpperCase().replace(/\s+/g, "");
    if (!label || label === "BN" || label === "IR") continue;
    const slot = SLOT_LABELS[label];
    if (!slot) continue;
    starters[slot] = (starters[slot] ?? 0) + 1;
  }
  return starters;
}

function normalizeScoring(raw: string): LeagueSettings["scoring"] {
  const s = raw.toLowerCase();
  if (/\bppr\b/.test(s) && /half|0\.5/.test(s)) return "half-ppr";
  if (/\bppr\b|point per reception/.test(s)) return "ppr";
  return "standard";
}

function matchInt(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}
function matchStr(text: string, re: RegExp): string | undefined {
  return text.match(re)?.[1]?.trim();
}
