import type { BoardEntry } from "../draft/board.js";
import type { LeagueSettings } from "../draft/types.js";
import type { LineupPlan, RosterReadResult } from "../lineup/types.js";
import type { FreeAgent } from "../waivers/types.js";

export type { RosterReadResult } from "../lineup/types.js";

/**
 * A league data source. Yahoo drives a Playwright browser; ESPN hits the
 * Fantasy v3 JSON API. Both return the same provider-agnostic shapes so the
 * pure logic in draft/ and lineup/ never has to care which one is active.
 */
export interface LeagueProvider {
  /** Roster slots, scoring, team count, draft type. */
  getLeagueSettings(): Promise<LeagueSettings>;
  /** Every draftable player, ordered by ADP (fallback expert rank). */
  getDraftBoard(): Promise<BoardEntry[]>;
  /** This team's current roster + the starting slot codes to fill. */
  getRoster(week?: number): Promise<RosterReadResult>;
  /** Available players (free agents + waivers) with week/season projections. */
  getFreeAgents(week?: number): Promise<FreeAgent[]>;
  /** Push a computed lineup. `dryRun` computes/validates but never writes. */
  applyLineup(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void>;
  /** Release any resources (browser, sockets). Safe to call more than once. */
  close(): Promise<void>;
}
