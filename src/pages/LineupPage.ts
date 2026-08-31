import type { Page } from "@playwright/test";
import type { Config } from "../config.js";
import { TeamPage } from "./TeamPage.js";
import type { LineupPlan, Player, PlayerStatus, RosterReadResult } from "../lineup/types.js";
import { slotLabel } from "../lineup/optimizer.js";

export type { RosterReadResult } from "../lineup/types.js";

/**
 * All Yahoo-specific selectors live here. Yahoo ships no stable test ids, so
 * expect to adjust these once against the real logged-in DOM:
 *
 *   npm run codegen        # click around your lineup page, copy selectors
 *   npm run roster         # prints what these selectors currently scrape
 *
 * Each entry lists a primary guess and fallbacks tried in order.
 */
const SELECTORS = {
  // The roster tables. Yahoo classic: starters + bench in separate tables.
  rosterTable: ['table:has(th:has-text("Proj"))', "#statTable0", 'div[data-tst="roster"] table'],
  playerRow: ["tbody tr"],
  // Cell holding the slot/position label ("QB", "W/R/T", "BN").
  slotCell: ['td[class*="pos"]', "td:first-child"],
  // The player's name link.
  playerNameLink: ['a[href*="/players/"]', "a.ysf-player-name", '[class*="player-name"] a'],
  // Small status flag next to the name ("Q", "O", "IR", "BYE").
  statusFlag: ['span[class*="status"]', "abbr", 'span[class*="game-status"]'],
  // Projected points cell — usually labeled column "Proj".
  projCell: ['td[class*="proj"]', "td.Proj"],
  // NFL team + position sub-line, e.g. "KC - WR".
  teamPosMeta: ['span[class*="player-status"]', '[class*="ysf-player-detail"]', "td:nth-child(2) span"],
  // "Edit" toggle that opens the editable lineup.
  editToggle: ['a:has-text("Edit")', 'button:has-text("Edit Lineup")'],
  // Per-row position <select> in the editable view (classic UI).
  rowPositionSelect: ["select"],
  // Save button in the editable lineup.
  saveButton: ['button:has-text("Save")', 'input[type="submit"][value*="Save"]'],
  // Post-save confirmation banner.
  saveConfirm: ['text=/lineup.*saved/i', 'div[role="status"]'],
} as const;

const STATUS_MAP: Record<string, PlayerStatus> = {
  Q: "Q",
  D: "D",
  O: "O",
  OUT: "O",
  IR: "IR",
  "IR-R": "IR",
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
  }

  /**
   * Scrape every roster row into a Player. Runs in the page so a single
   * DOM shape change is a one-place fix here rather than many awaits.
   */
  async readRoster(): Promise<RosterReadResult> {
    const raw = await this.page
      .evaluate(scrapeRoster, {
        tableSelectors: SELECTORS.rosterTable as unknown as string[],
        nameSelectors: SELECTORS.playerNameLink as unknown as string[],
        slotSelectors: SELECTORS.slotCell as unknown as string[],
        statusSelectors: SELECTORS.statusFlag as unknown as string[],
        projSelectors: SELECTORS.projCell as unknown as string[],
        metaSelectors: SELECTORS.teamPosMeta as unknown as string[],
      })
      .catch(() => null);

    if (!raw || raw.length === 0) {
      const base = await this.dumpDebug("roster-scrape-empty");
      throw new Error(
        `Could not read any roster rows. The Yahoo DOM likely differs from the ` +
          `guessed selectors in src/pages/LineupPage.ts.\n` +
          `Saved page HTML + screenshot to ${base}.{html,png}.\n` +
          `Run \`npm run codegen\` against your lineup page and update SELECTORS.`,
      );
    }

    const players: Player[] = raw.map((r, i) => {
      const status = parseStatus(r.statusText);
      const eligibleSlots = deriveEligibleSlots(r.position, r.slot);
      return {
        id: r.playerId || `${r.name}|${r.team}` || `row-${i}`,
        name: r.name.trim(),
        team: r.team.trim().toUpperCase(),
        position: r.position.trim().toUpperCase(),
        eligibleSlots,
        projectedPoints: Number.isFinite(r.proj) ? r.proj : 0,
        status,
        currentSlot: normalizeSlot(r.slot),
      };
    });

    const startingSlotCodes = players
      .map((p) => p.currentSlot)
      .filter((s) => s !== "BN" && s !== "IR");

    return { players, startingSlotCodes };
  }

  /**
   * Apply a plan by setting each player's position via the classic per-row
   * <select>, then Save. If your league's UI is the drag/swap variant this
   * will fail loudly with a debug dump — update the SELECTORS + this method.
   */
  async applyPlan(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void> {
    if (opts.dryRun) return;

    await this.openEditor();

    for (const assignment of plan.assignments) {
      if (!assignment.player) continue;
      await this.setPlayerSlot(assignment.player.name, slotLabel(assignment.slot));
    }
    for (const benched of plan.bench) {
      await this.setPlayerSlot(benched.name, "BN").catch(() => {
        /* player may already be benched / not have a select */
      });
    }

    await this.save();
  }

  private async openEditor(): Promise<void> {
    for (const sel of SELECTORS.editToggle) {
      const el = this.page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await this.page.waitForLoadState("domcontentloaded");
        return;
      }
    }
    // Some leagues land directly on an editable table; that's fine.
  }

  private async setPlayerSlot(playerName: string, slot: string): Promise<void> {
    const row = this.page.locator("tr", { hasText: playerName }).first();
    const select = row.locator(SELECTORS.rowPositionSelect[0]!).first();
    if (!(await select.isVisible().catch(() => false))) {
      throw new Error(`No position dropdown found for "${playerName}".`);
    }
    await select.selectOption({ label: slot }).catch(async () => {
      await select.selectOption({ value: slot });
    });
  }

  private async save(): Promise<void> {
    for (const sel of SELECTORS.saveButton) {
      const btn = this.page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await this.page
          .locator(SELECTORS.saveConfirm[0]!)
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        return;
      }
    }
    const base = await this.dumpDebug("lineup-save-no-button");
    throw new Error(`Could not find a Save button. Debug dump: ${base}.{html,png}`);
  }
}

function parseStatus(text: string): PlayerStatus {
  const t = text.trim().toUpperCase();
  if (!t) return "OK";
  return STATUS_MAP[t] ?? "OK";
}

function normalizeSlot(slot: string): string {
  const s = slot.trim().toUpperCase();
  if (!s || s === "BENCH") return "BN";
  return s;
}

/**
 * Yahoo's roster table doesn't spell out flex eligibility, so infer it from the
 * primary position. RB/WR/TE get the W/R/T flex; adjust if your league uses
 * different flex rules (e.g. W/R, Q/W/R/T).
 */
function deriveEligibleSlots(position: string, currentSlot: string): string[] {
  const pos = position.trim().toUpperCase();
  const slots = new Set<string>([pos]);
  if (["RB", "WR", "TE"].includes(pos)) slots.add("W/R/T");
  const cur = normalizeSlot(currentSlot);
  if (cur !== "BN" && cur !== "IR") slots.add(cur);
  return [...slots];
}

/* ---- runs inside the browser ---- */
interface ScrapeArgs {
  tableSelectors: string[];
  nameSelectors: string[];
  slotSelectors: string[];
  statusSelectors: string[];
  projSelectors: string[];
  metaSelectors: string[];
}
interface ScrapedRow {
  playerId: string;
  name: string;
  team: string;
  position: string;
  slot: string;
  statusText: string;
  proj: number;
}

function scrapeRoster(args: ScrapeArgs): ScrapedRow[] {
  const pick = (root: Element | Document, sels: string[]): Element | null => {
    for (const s of sels) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  let table: Element | null = null;
  for (const s of args.tableSelectors) {
    table = document.querySelector(s);
    if (table) break;
  }
  const tables = table
    ? [table, ...Array.from(document.querySelectorAll(args.tableSelectors[0] ?? "table"))]
    : Array.from(document.querySelectorAll("table"));

  const rows: ScrapedRow[] = [];
  const seen = new Set<string>();

  for (const t of tables) {
    for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
      const nameEl = pick(tr, args.nameSelectors) as HTMLAnchorElement | null;
      if (!nameEl) continue;
      const name = (nameEl.textContent ?? "").trim();
      if (!name) continue;

      const href = nameEl.getAttribute("href") ?? "";
      const idMatch = href.match(/\/players\/(\d+)/) ?? href.match(/pid=(\d+)/);
      const playerId = idMatch?.[1] ?? "";
      if (playerId && seen.has(playerId)) continue;
      if (playerId) seen.add(playerId);

      const slotEl = pick(tr, args.slotSelectors);
      const slot = (slotEl?.textContent ?? "").trim();

      const statusEl = pick(tr, args.statusSelectors);
      const statusText = (statusEl?.textContent ?? statusEl?.getAttribute("title") ?? "").trim();

      const metaEl = pick(tr, args.metaSelectors);
      const meta = (metaEl?.textContent ?? "").replace(/\s+/g, " ").trim();
      const metaMatch = meta.match(/([A-Za-z]{2,4})\s*[-–]\s*([A-Za-z/]{1,7})/);
      const team = metaMatch?.[1] ?? "";
      const position = metaMatch?.[2] ?? slot.replace(/[^A-Za-z/]/g, "");

      const projEl = pick(tr, args.projSelectors);
      let projText = (projEl?.textContent ?? "").trim();
      if (!projText) {
        // fall back: last numeric-looking cell
        const cells = Array.from(tr.querySelectorAll("td"))
          .map((c) => (c.textContent ?? "").trim())
          .filter((v) => /^\d+(\.\d+)?$/.test(v));
        projText = cells[cells.length - 1] ?? "0";
      }
      const proj = Number.parseFloat(projText) || 0;

      rows.push({ playerId, name, team, position, slot, statusText, proj });
    }
  }
  return rows;
}
