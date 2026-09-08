import type { BoardEntry } from "../draft/board.js";
import type { LeagueSettings } from "../draft/types.js";
import type { LineupPlan, RosterReadResult } from "../lineup/types.js";
import type { FreeAgent } from "../waivers/types.js";

export type { RosterReadResult } from "../lineup/types.js";

/** One completed draft selection. */
export interface DraftPick {
  /** `overallPickNumber` — 1-based across the whole draft. */
  overall: number;
  /** `roundId` — 1-based. */
  round: number;
  /** `roundPickNumber` — 1-based within the round. */
  pickInRound: number;
  /** League team that made the pick. */
  teamId: number;
  /** Player taken. `String(playerId)` — joins to `BoardEntry.player.id`. */
  playerId: string;
  /** Pre-draft keeper selection rather than a live pick. */
  keeper: boolean;
}

/** Snapshot of the draft room at one moment. */
export interface DraftState {
  /** The draft has finished. */
  drafted: boolean;
  /** The draft is live (a clock is running). */
  inProgress: boolean;
  /** Every pick made so far, in draft order. Grows as the draft proceeds. */
  picks: DraftPick[];
  /** My 1-based draft slot, when the provider knows it up front (Sleeper).
   *  Undefined for providers that only reveal it via the round-1 pick (ESPN). */
  mySlot?: number | null;
  /** My league team id, when the provider can identify it (Sleeper roster id).
   *  Undefined otherwise — the CLI falls back to config. */
  myTeamId?: number | null;
}

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
  /** Live draft-room snapshot (ESPN only — Yahoo drafts run off-platform). */
  getDraftState(): Promise<DraftState>;
  /** This team's current roster + the starting slot codes to fill. */
  getRoster(week?: number): Promise<RosterReadResult>;
  /** Available players (free agents + waivers) with week/season projections. */
  getFreeAgents(week?: number): Promise<FreeAgent[]>;
  /** Push a computed lineup. `dryRun` computes/validates but never writes. */
  applyLineup(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void>;
  /** Release any resources (browser, sockets). Safe to call more than once. */
  close(): Promise<void>;
}
