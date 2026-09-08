import type { BoardRow } from "../board.js";
import { willLast } from "./survival.js";

/** Survival probability the "next available" player must clear to count as
 *  realistically still gettable at my next pick. */
const SURVIVE_MIN = 0.5;

export interface Vona {
  /** candidate.vor − nextBest.vor. Same position, so the positional replacement
   *  term cancels — this is the projected-points drop, not just a VOR delta. */
  gap: number;
  /** The player the gap is measured against. */
  nextName: string;
  nextAdp: number | null;
}

/**
 * Value Over Next Available — how much value you give up at this position by
 * passing now and taking your realistic next-best at the spot instead. "Next
 * available" = the best same-position player (by VOR) who is more likely than
 * not to survive to `myNextOverall`.
 *
 * Returns null when the candidate has no VOR, there's no known next pick, or no
 * same-position player is likely to last.
 */
export function computeVona(
  candidate: BoardRow,
  available: readonly BoardRow[],
  myNextOverall: number | null,
): Vona | null {
  if (candidate.vor == null || myNextOverall == null) return null;
  const pos = candidate.player.position;

  const pool = available
    .filter(
      (r) =>
        r.player.id !== candidate.player.id &&
        r.player.position === pos &&
        r.vor != null,
    )
    .sort((a, b) => (b.vor as number) - (a.vor as number));

  for (const r of pool) {
    const prob = willLast(r.adp, myNextOverall, r.adpStdev).prob;
    // null prob = no ADP, can't reason — treat as gettable, like survival.ts does
    if (prob == null || prob >= SURVIVE_MIN) {
      return {
        gap: Math.round((candidate.vor - (r.vor as number)) * 10) / 10,
        nextName: r.player.name,
        nextAdp: r.adp,
      };
    }
  }
  return null;
}
