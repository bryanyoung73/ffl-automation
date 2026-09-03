import type { Position } from "../types.js";

/**
 * Shared shapes for the live draft assistant (`npm run draft`). The engine's
 * output types (`DraftAdvice`, `Rec`, …) land here in a later phase; for now
 * this is the roster-need read and the board-context signals.
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
