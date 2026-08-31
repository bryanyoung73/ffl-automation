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
}

/** What a provider returns from a roster read: the players plus the current
 *  starting slot codes in canonical order (bench/IR excluded). */
export interface RosterReadResult {
  players: Player[];
  /** Slot codes of the current starting lineup, in table order. */
  startingSlotCodes: string[];
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
  currentProjected: number;
  proposedProjected: number;
  /** proposedProjected - currentProjected */
  delta: number;
}

/** Statuses that make a player ineligible to start, unless overridden. */
export const DEFAULT_UNSTARTABLE: readonly PlayerStatus[] = ["O", "IR", "PUP", "SUSP", "BYE", "NA"];
