import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { LineupPlan, Player, PlayerStatus, RosterReadResult } from "../lineup/types.js";
import { slotLabel } from "../lineup/optimizer.js";

export type { RosterReadResult } from "../lineup/types.js";

/**
 * Yahoo's classic team/lineup editor (verified against league 891808 on
 * 2026-09-01). Every roster player has a `<select name="<playerId>">` whose
 * option values are that player's eligible slots plus BN (and IR when allowed);
 * the selected option is the current slot. Changing a slot = `selectOption` on
 * that element; saving = the roster form's "Save Changes" submit.
 *
 * The scrape reads the projected-points column, so navigate to the projection
 * stat view (config.lineupUrl already pins `stat1=P&stat2=PW`).
 *
 * Class names on this page are Yahoo's atomic CSS (`Ta-start`, `Bdr`, ...) and
 * unstable — anchor on `select[name]`, `data-pos`, `a[data-ys-playerid]`, and
 * column order instead. A scrape miss dumps HTML + screenshot to output/.
 */
const SELECTORS = {
  playerSelect: 'select[name]',
  saveButton: [
    "button.roster-save-btn",
    'button:has-text("Save Changes")',
    'input[name="jsubmit"]',
  ],
  saveConfirm: ['text=/saved/i', 'div[role="status"]', ".roster-save-success"],
} as const;

const STATUS_MAP: Record<string, PlayerStatus> = {
  Q: "Q",
  D: "D",
  O: "O",
  OUT: "O",
  IR: "IR",
  "IR-R": "IR",
  "IR-DESIGNATED": "IR",
  PUP: "PUP",
  SUSP: "SUSP",
  NA: "NA",
  BYE: "BYE",
};

export class LineupPage extends TeamPage {
  constructor(page: Page, config: Config) {
    super(page, config);
  }

  async goto(): Promise<void> {
    await this.page.goto(this.config.lineupUrl, { waitUntil: "domcontentloaded" });
    await this.assertLoggedIn();
    await this.page.waitForSelector(SELECTORS.playerSelect, { timeout: 20_000 }).catch(() => undefined);
  }

  async readRoster(): Promise<RosterReadResult> {
    const raw = await this.page.evaluate(scrapeRoster).catch(() => [] as ScrapedRow[]);

    if (raw.length === 0) {
      const base = await this.dumpDebug("roster-scrape-empty");
      throw new Error(
        `Could not read any roster rows. The Yahoo DOM likely differs from ` +
          `src/pages/LineupPage.ts.\nSaved HTML + screenshot to ${base}.{html,png}.`,
      );
    }

    const players: Player[] = raw.map((r, i) => ({
      id: r.playerId || `${r.name}|${r.team}` || `row-${i}`,
      name: r.name.trim(),
      team: r.team.trim().toUpperCase(),
      position: r.position.trim().toUpperCase(),
      eligibleSlots: r.eligibleSlots.filter((s) => s !== "BN" && s !== "IR"),
      projectedPoints: Number.isFinite(r.proj) ? r.proj : 0,
      status: parseStatus(r.statusText),
      currentSlot: normalizeSlot(r.slot),
    }));

    const startingSlotCodes = players
      .map((p) => p.currentSlot)
      .filter((s) => s !== "BN" && s !== "IR");

    return { players, startingSlotCodes };
  }

  /**
   * Apply a plan: set each player's `<select>` to its target slot, then save.
   * Order matters — Yahoo rejects a move into an occupied slot, so bench first,
   * then fill. `dryRun` short-circuits before any DOM change.
   */
  async applyPlan(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void> {
    if (opts.dryRun) return;

    const startingIds = new Set(
      plan.assignments.filter((a) => a.player).map((a) => a.player!.id),
    );

    for (const benched of plan.bench) {
      if (!startingIds.has(benched.id)) {
        await this.setSlotById(benched.id, "BN").catch(() => undefined);
      }
    }
    for (const assignment of plan.assignments) {
      if (!assignment.player) continue;
      await this.setSlotById(assignment.player.id, slotLabel(assignment.slot));
    }

    await this.save();
  }

  private async setSlotById(playerId: string, slot: string): Promise<void> {
    const select = this.page.locator(`select[name="${playerId}"]`).first();
    if ((await select.count()) === 0) {
      throw new Error(`No slot <select> for player ${playerId}.`);
    }
    await select.selectOption(slot).catch(async () => {
      await select.selectOption({ label: slot });
    });
  }

  private async save(): Promise<void> {
    for (const sel of SELECTORS.saveButton) {
      const btn = this.page.locator(sel).first();
      if ((await btn.count()) === 0) continue;
      await btn.click({ force: true }).catch(() => undefined);
      await this.page
        .locator(SELECTORS.saveConfirm[0]!)
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => undefined);
      return;
    }
    const base = await this.dumpDebug("lineup-save-no-button");
    throw new Error(`Could not find a Save button. Debug dump: ${base}.{html,png}`);
  }
}

function parseStatus(text: string): PlayerStatus {
  const t = text.trim().toUpperCase().replace(/[^A-Z-]/g, "");
  if (!t) return "OK";
  return STATUS_MAP[t] ?? "OK";
}

function normalizeSlot(slot: string): string {
  const s = slot.trim().toUpperCase();
  if (!s || s === "BENCH") return "BN";
  return s;
}

/* ---- runs in the browser: top-level fn, no nested named fns (esbuild __name) ---- */
interface ScrapedRow {
  playerId: string;
  name: string;
  team: string;
  position: string;
  slot: string;
  eligibleSlots: string[];
  statusText: string;
  proj: number;
}

function scrapeRoster(): ScrapedRow[] {
  const rows: ScrapedRow[] = [];
  const selects = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select[name]"),
  ).filter((s) => /^\d+$/.test(s.name));

  for (const select of selects) {
    const tr = select.closest("tr");
    if (!tr) continue;

    const options = Array.from(select.options).map((o) => o.value);
    const slot = select.value || options[0] || "BN";

    const link =
      tr.querySelector<HTMLAnchorElement>("a[data-ys-playerid]") ??
      tr.querySelector<HTMLAnchorElement>('a[href*="/nfl/players/"]');
    const name = (link?.getAttribute("title") || link?.textContent || "").trim();
    if (!name) continue;

    const rowText = (tr.textContent || "").replace(/\s+/g, " ");
    const tp = rowText.match(/\b([A-Za-z]{2,4})\s*-\s*(QB|RB|WR|TE|K|DEF)\b/);
    const team = tp?.[1] ?? "";
    const position = tp?.[2] ?? options.find((o) => o !== "BN" && o !== "IR") ?? "";

    const cells = Array.from(tr.querySelectorAll("td")).map((c) =>
      (c.textContent || "").trim(),
    );
    // Column order: Pos, Edit(select), Offense(player), Bye, Fan Pts, ...
    const selectTd = select.closest("td");
    const selIdx = selectTd ? Array.from(tr.querySelectorAll("td")).indexOf(selectTd) : 1;
    const byeText = cells[selIdx + 2] ?? "";
    const projText = cells[selIdx + 3] ?? "";
    const proj = Number.parseFloat(projText.replace(/[^\d.]/g, "")) || 0;
    void byeText;

    const statusEl =
      tr.querySelector("abbr[title]") ??
      tr.querySelector('[class*="ysf-player-status"]');
    const statusText = (
      statusEl?.getAttribute("title") ||
      statusEl?.textContent ||
      ""
    ).trim();

    rows.push({
      playerId: link?.getAttribute("data-ys-playerid") ||
        link?.getAttribute("href")?.match(/\/nfl\/players\/(\d+)/)?.[1] ||
        select.name,
      name,
      team,
      position,
      slot,
      eligibleSlots: options,
      statusText,
      proj,
    });
  }
  return rows;
}
