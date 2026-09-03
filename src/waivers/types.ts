import type { PlayerStatus } from "../lineup/types.js";

/** An available player from the provider's free-agent / waiver list. */
export interface FreeAgent {
  id: string;
  name: string;
  team: string;
  position: string;
  /** Slot codes this player can fill (bench implied), e.g. ["RB","W/R/T"]. */
  eligibleSlots: string[];
  /** Projected points for the target week. */
  weekProj: number;
  /** Projected points for the full season. */
  seasonProj: number;
  /** Fantasy points already scored this season (0 early in the year). */
  actualSoFar: number;
  /** FA = add instantly; WAIVERS = must bid / claim. */
  availability: "FA" | "WAIVERS";
  /** Rostered percentage across ESPN leagues (0–100). */
  pctOwned: number;
  /** Recent change in rostered percentage — the waiver-buzz signal. */
  pctChange: number;
  status: PlayerStatus;
  bye: number | null;
}

/** The blended value the add/drop logic ranks on. */
export interface PlayerValue {
  id: string;
  /** Rest-of-season points above positional replacement. */
  rosVal: number;
  /** This week's intel-adjusted projection. */
  weekVal: number;
  /** Small boost from rising rostered %. */
  buzz: number;
  /** `w*rosVal + (1-w)*weekVal + buzz` — what everything sorts on. */
  blended: number;
}

export interface AddDropPair {
  add: FreeAgent;
  addValue: PlayerValue;
  /** null for a streaming suggestion where you'd just swap same-slot. */
  drop: { id: string; name: string; position: string } | null;
  dropValue: PlayerValue | null;
  /** add.blended - drop.blended. */
  gain: number;
  /** One-line why (top intel note, or the matchup for streaming). */
  reason: string;
  kind: "roster" | "streaming";
}

export interface WaiverReport {
  week: number;
  /** ROS weight used for the blend (1 = pure ROS, 0 = pure this-week). */
  rosWeight: number;
  pairs: AddDropPair[];
  streaming: AddDropPair[];
  /** Positions where the best FA doesn't beat your bench. */
  skippedPositions: string[];
  intelAsOf: string;
}
