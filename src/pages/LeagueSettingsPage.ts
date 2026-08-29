import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { LeagueSettings, SlotCode } from "../draft/types.js";

/**
 * Scrape roster + scoring from /f1/<league>/settings and the team count from the
 * league standings page.
 *
 * The settings page renders as flat "Label: Value" text, so we read innerText
 * and pattern-match — robust to layout churn. Verified against league 891808 on
 * 2026-08-29; re-check regexes if a field can't be found (a miss dumps to
 * artifacts/).
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
  "Q/W/R/T": "W/R/T",
  FLEX: "W/R/T",
};

export class LeagueSettingsPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async read(): Promise<LeagueSettings> {
    await this.page.goto(this.config.leagueSettingsUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();
    const text = await this.bodyText();

    const starters = parseRoster(text);
    const receptionPts = matchFloat(text, /Receptions?\s+(-?\d+(?:\.\d+)?)/i) ?? 0;
    const draftRaw = matchStr(text, /Draft Type\s*:?\s*([A-Za-z ]+)/i) ?? "";
    const benchSize = countSlot(text, "BN");

    const teams = await this.readTeamCount();

    if (!teams || Object.keys(starters).length === 0) {
      const base = await this.dumpDebug("league-settings-parse");
      throw new Error(
        `Could not parse league settings (teams=${teams}, starters=${JSON.stringify(starters)}).\n` +
          `Update LeagueSettingsPage. Debug dump: ${base}.{html,png}`,
      );
    }

    return {
      teams,
      scoring: receptionPts >= 1 ? "ppr" : receptionPts > 0 ? "half-ppr" : "standard",
      starters,
      benchSize: benchSize || 6,
      draftType: /auction/i.test(draftRaw) ? "auction" : "snake",
    };
  }

  /** Count team rows on the league standings page. */
  async readTeamCount(): Promise<number> {
    await this.page.goto(`${this.config.baseUrl}/f1/${this.config.leagueId}`, {
      waitUntil: "domcontentloaded",
    });
    await this.assertLoggedIn();
    const count = await this.page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/f1/"]'),
      );
      const teamIds = new Set<string>();
      for (const a of links) {
        const m = a.getAttribute("href")?.match(/\/f1\/\d+\/(\d+)(?:$|[/?])/);
        if (m) teamIds.add(m[1]!);
      }
      return teamIds.size;
    });
    return count;
  }

  private async bodyText(): Promise<string> {
    return this.page.evaluate(() => {
      const root =
        (document.querySelector("#settings-content") as HTMLElement | null) ??
        (document.body as HTMLElement);
      return (root.innerText || root.textContent || "").replace(/ /g, " ").replace(/\r/g, "");
    });
  }
}

function parseRoster(text: string): LeagueSettings["starters"] {
  const line = matchStr(text, /Roster\s*Positions\s*:?\s*([A-Z/,\s]+?)(?:Fractional|Bench|$)/i);
  const starters: LeagueSettings["starters"] = {};
  if (!line) return starters;
  for (const token of line.split(",")) {
    const label = token.trim().toUpperCase().replace(/\s+/g, "");
    if (!label || label === "BN" || label === "IR") continue;
    const slot = SLOT_LABELS[label];
    if (slot) starters[slot] = (starters[slot] ?? 0) + 1;
  }
  return starters;
}

function countSlot(text: string, code: string): number {
  const line = matchStr(text, /Roster\s*Positions\s*:?\s*([A-Z/,\s]+?)(?:Fractional|$)/i) ?? "";
  return line.split(",").filter((t) => t.trim().toUpperCase() === code).length;
}

function matchFloat(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m?.[1] ? Number.parseFloat(m[1]) : undefined;
}
function matchStr(text: string, re: RegExp): string | undefined {
  return text.match(re)?.[1]?.trim();
}
