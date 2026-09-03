import type { PlayerRef, Position } from "../types.js";
import type { Survival } from "./survival.js";

/**
 * Shared shapes for the live draft assistant (`npm run draft`): the roster-need
 * read, the board-context signals, and the engine's `DraftAdvice` output.
 */

/**
 * Per-position read of my roster mid-draft, with an urgency `weight` the
 * recommendation engine multiplies into player value.
 */
export interface PositionNeed {
  position: Position;
  /** Mine that fill a dedicated starting slot at this position. */
  haveStarters: number;
  /** Dedicated starting slots still open (FLEX excluded). */
  startersLeft: number;
  /** Expected share of the open FLEX slot(s) this position should target. */
  flexShare: number;
  /** Mine beyond the dedicated need — depth. */
  haveBench: number;
  /** Engine urgency multiplier: > 1 while a slot is open, a small floor once set. */
  weight: number;
}

/**
 * A thinning value tier: only so many players left at `position` before a
 * meaningful drop to the next tier. Emitted only when the tier is nearly
 * exhausted and the drop is real.
 */
export interface Cliff {
  position: Position;
  /** Players still available in the current tier. */
  remaining: number;
  /** Their names, best first — for the render. */
  players: string[];
  /** Value lost between the last player in this tier and the next best. */
  drop: number;
  /** What `drop` is measured in: VOR points, or ADP slots. */
  metric: "vor" | "adp";
}

/** A positional run: `count` of the last `window` picks went to `position`. */
export interface Run {
  position: Position;
  count: number;
  window: number;
}

/** One ranked pick suggestion. */
export interface Rec {
  player: PlayerRef;
  adp: number | null;
  vor: number | null;
  vorRank: number | null;
  ecrPosRank: string | null;
  /** The position's need weight that scaled this player's value. */
  needWeight: number;
  /** Odds he lasts to my next pick. */
  survival: Survival;
  /** The ranking number: need-weighted value + survival/cliff/run bumps. */
  score: number;
  /** 1–3 short clauses, most important first. */
  reasons: string[];
}

/** My roster so far, one entry per position (players may be empty). */
export interface RosterSlotView {
  position: Position;
  players: string[];
}

/** Everything the `npm run draft` renderer needs for one recompute. */
export interface DraftAdvice {
  /** The pick currently on the clock is mine. */
  onClock: boolean;
  /** Overall number of the pick on the clock (or the last pick, once done). */
  overall: number;
  /** "round.pickInRound" label for `overall`, e.g. "3.07". */
  label: string;
  /** Overall number of my next pick, null when unknown or none left. */
  myNextOverall: number | null;
  /** Picks between now and my next one (0 = on the clock), null when unknown. */
  picksUntilNext: number | null;
  /** Fraction of the draft complete, 0–1. */
  pctComplete: number;
  /** Draft slot in use: detected from round 1, else the passed value, else null. */
  slot: number | null;
  myRoster: RosterSlotView[];
  recommendations: Rec[];
  cliffs: Cliff[];
  runs: Run[];
}
