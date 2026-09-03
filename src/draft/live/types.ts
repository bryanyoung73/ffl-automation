import type { Position } from "../types.js";

/**
 * Shared shapes for the live draft assistant (`npm run draft`). The engine's
 * output types (`DraftAdvice`, `Rec`, …) land here in a later phase; for now
 * this is the roster-need read that the turn/needs math produces.
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
