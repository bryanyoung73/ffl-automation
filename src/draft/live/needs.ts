import { POSITIONS, type LeagueSettings, type PlayerRef, type Position } from "../types.js";
import type { DraftState } from "../../providers/types.js";
import type { PositionNeed } from "./types.js";

const FLEX: readonly Position[] = ["RB", "WR", "TE"];

/**
 * Depth value once a position's starting slots are filled — a backup RB is
 * worth more early than a backup K. Multiplies normalised VOR in the engine.
 */
const DEPTH_FLOOR: Record<Position, number> = {
  RB: 0.55,
  WR: 0.5,
  TE: 0.3,
  QB: 0.2,
  K: 0.1,
  DEF: 0.1,
};

/** K/DEF never earn an early-round bump, however many slots are open. */
const LATE_ONLY: ReadonlySet<Position> = new Set<Position>(["K", "DEF"]);
const LATE_ONLY_CAP = 0.9;

/**
 * My drafted players, resolved against the board so each carries a position.
 * Picks not on the board — a keeper deeper than the top ~300 — are dropped.
 */
export function myRoster<T extends { player: PlayerRef }>(
  state: DraftState,
  myTeamId: number,
  board: readonly T[],
): T[] {
  const byId = new Map(board.map((e) => [e.player.id, e]));
  const out: T[] = [];
  for (const pick of state.picks) {
    if (pick.teamId !== myTeamId) continue;
    const entry = byId.get(pick.playerId);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Positional need from my roster so far. `weight` is the engine's urgency
 * multiplier: `> 1` while a dedicated or FLEX slot is open, a small positive
 * floor once the position is set. K/DEF are capped so they never rise into the
 * early rounds. Returned in `POSITIONS` order.
 */
export function rosterNeeds(
  mine: readonly { player: PlayerRef }[],
  settings: LeagueSettings,
): PositionNeed[] {
  const count = new Map<Position, number>(POSITIONS.map((p) => [p, 0]));
  for (const e of mine) {
    const pos = e.player.position;
    count.set(pos, (count.get(pos) ?? 0) + 1);
  }

  const dedicated = (p: Position): number => settings.starters[p] ?? 0;

  // FLEX: RB/WR/TE bodies beyond their dedicated slots absorb the W/R/T slot(s).
  const flexSlots = settings.starters["W/R/T"] ?? 0;
  let flexBodies = 0;
  for (const p of FLEX) flexBodies += Math.max(0, (count.get(p) ?? 0) - dedicated(p));
  const flexOpen = Math.max(0, flexSlots - Math.min(flexSlots, flexBodies));
  const flexDenom = FLEX.reduce((s, p) => s + dedicated(p), 0) || FLEX.length;

  return POSITIONS.map((position) => {
    const have = count.get(position) ?? 0;
    const ded = dedicated(position);
    const haveStarters = Math.min(have, ded);
    const startersLeft = Math.max(0, ded - have);
    const haveBench = Math.max(0, have - ded);
    const flexShare =
      FLEX.includes(position) && flexOpen > 0
        ? (flexOpen * (ded || 1)) / flexDenom
        : 0;

    const openNeed = startersLeft + flexShare;
    let weight = openNeed > 0 ? 1 + openNeed : DEPTH_FLOOR[position];
    if (LATE_ONLY.has(position)) weight = Math.min(weight, LATE_ONLY_CAP);

    return {
      position,
      haveStarters,
      startersLeft,
      flexShare: round2(flexShare),
      haveBench,
      weight: round2(weight),
    };
  });
}

/**
 * Escalate still-open *starting* slots as the draft winds down. `rosterNeeds`
 * caps K/DEF low so you don't reach for a kicker in round 3 — but that cap is
 * wrong at the end of the draft with an unfilled mandatory slot. Two effects:
 *
 * - a gentle ramp once the draft is past ~55% done, so a needed K/DEF starts
 *   beating pure depth by the late-middle rounds;
 * - "last call": when you have no more picks than you have holes, every hole
 *   becomes urgent (you'll otherwise end with an empty starting slot).
 *
 * @param myPicksLeft  my remaining picks; pass a large number when unknown
 * @param pctComplete  fraction of the whole draft done, 0–1
 */
export function escalateLateNeeds(
  needs: readonly PositionNeed[],
  opts: { myPicksLeft: number; pctComplete: number },
): PositionNeed[] {
  const holeCount = needs.reduce((s, n) => s + n.startersLeft, 0);
  const lastCall = holeCount > 0 && opts.myPicksLeft <= holeCount;
  const ramp = Math.max(0, opts.pctComplete - 0.55) * 6; // 0 until ~55%, ~2.7 by the end

  return needs.map((n) => {
    if (n.startersLeft <= 0) return n;
    const weight = lastCall
      ? Math.max(n.weight, 5 + n.startersLeft) // must-fill: dominate depth picks
      : round2(n.weight + ramp);
    return { ...n, weight };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
