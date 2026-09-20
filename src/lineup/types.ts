/** Player availability. Anything other than OK/Q/D is treated as un-startable by default. */
export type PlayerStatus =
  | "OK"
  | "Q" // questionable
  | "D" // doubtful
  | "O" // out
  | "IR"
  | "PUP"
  | "SUSP"
  | "BYE"
  | "NA"; // not active / covid / other

export interface Player {
  /** Stable key — Yahoo player id when available, else `${name}|${team}`. */
  id: string;
  name: string;
  /** NFL team abbreviation, e.g. "KC". Empty string if unknown. */
  team: string;
  /** Primary position, e.g. "WR". */
  position: string;
  /**
   * Slot codes this player may fill, exactly as Yahoo labels them,
   * e.g. ["WR", "W/R/T"]. Bench ("BN") is implied and need not be listed.
   */
  eligibleSlots: string[];
  /** Yahoo projected points for the target week. */
  projectedPoints: number;
  status: PlayerStatus;
  /** Slot the player currently occupies, e.g. "WR", "BN", "W/R/T". */
  currentSlot: string;
  /** Full-season projected points, when the provider has it (ESPN). Waiver-wire. */
  seasonProjectedPoints?: number;
  /** Fantasy points scored so far this season, when available (ESPN). Waiver-wire. */
  pointsSoFar?: number;
  /** His game has started — the slot can't change. The optimizer pins these
   *  (a locked player is an immovable constraint, like a bye), so no proposed
   *  move touches him and the submit isn't rejected. ESPN only for now. */
  locked?: boolean;
  /**
   * ISO kickoff time for this player's game this week, when known (from
   * ESPN's public scoreboard — provider-agnostic, attached by the CLI/server
   * layer, not any one LeagueProvider). Used only to break ties among
   * assignments that already achieve the same optimal total: among
   * equally-valid labelings, the optimizer prefers holding the later-kickoff
   * (and, first, the injury-flagged) player in the flex slot. Never changes
   * which players start or the total.
   */
  kickoffAt?: string;
}

/** What a provider returns from a roster read: the players plus the current
 *  starting slot codes in canonical order (bench/IR excluded). */
export interface RosterReadResult {
  players: Player[];
  /** Slot codes of the current starting lineup, in table order. */
  startingSlotCodes: string[];
  /**
   * The actual NFL week these projections/news are for — resolved by the
   * provider (its own "current scoring period") when the caller didn't pin
   * one. Without this, downstream callers (the intel/LLM digest) fall back
   * to `config.week`, which is usually unset, and wrongly assume preseason
   * all season long. Undefined only for a provider that can't determine it
   * (Yahoo, for now).
   */
  week?: number;
}

export interface StartingSlot {
  /** Slot code, e.g. "QB", "RB", "W/R/T", "DEF". */
  code: string;
  /** 0-based index of this slot among identical codes (RB #0, RB #1, ...). */
  index: number;
}

export interface Assignment {
  slot: StartingSlot;
  player: Player | null;
}

export interface LineupPlan {
  assignments: Assignment[];
  bench: Player[];
  totalProjected: number;
}

export interface LineupChange {
  player: Player;
  fromSlot: string;
  toSlot: string;
}

export interface LineupDiff {
  changes: LineupChange[];
  /** True only when the set of starters changes (not just slot labels). */
  needsSubmit: boolean;
  currentProjected: number;
  proposedProjected: number;
  /** proposedProjected - currentProjected */
  delta: number;
}

/** Statuses that make a player ineligible to start, unless overridden. */
export const DEFAULT_UNSTARTABLE: readonly PlayerStatus[] = ["O", "IR", "PUP", "SUSP", "BYE", "NA"];
