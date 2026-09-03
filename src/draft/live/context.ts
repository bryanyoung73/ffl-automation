import type { LeagueSettings, Position } from "../types.js";
import type { BoardEntry, BoardRow } from "../board.js";
import type { DraftState } from "../../providers/types.js";
import type { Cliff, Run } from "./types.js";

/** Positions worth a cliff warning. K/DEF value curves are flat — no cliffs. */
const CLIFF_POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE"];
/** Only warn when a tier is down to this many players or fewer. */
const CLIFF_REMAINING_MAX = 3;
/** VOR-gap that ends a tier when no ECR tiers are available. */
const VOR_TIER_GAP = 12;
/** Minimum drop to bother reporting, per metric. */
const CLIFF_MIN_VOR_DROP = 10;
const CLIFF_MIN_ADP_DROP = 8;

/**
 * For each position, how many players remain in the current value tier and how
 * far the drop is to the next. Prefers FantasyPros ECR tiers (`row.ecrTier`);
 * falls back to a VOR-gap cut; skips a position with neither signal.
 *
 * @param available  board rows for players NOT yet drafted, any order
 */
export function tierCliffs(
  available: readonly BoardRow[],
  _settings: LeagueSettings,
): Cliff[] {
  const cliffs: Cliff[] = [];

  for (const position of CLIFF_POSITIONS) {
    const rows = available
      .filter((r) => r.player.position === position)
      .sort((a, b) => a.rank - b.rank);
    if (rows.length < 2) continue;

    const head = rows[0]!;
    let cut: number;
    if (head.ecrTier != null) {
      const tier = head.ecrTier;
      cut = rows.findIndex((r) => r.ecrTier !== tier);
      if (cut === -1) cut = rows.length;
    } else if (rows.some((r) => r.vor != null)) {
      cut = rows.length;
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!.vor;
        const cur = rows[i]!.vor;
        if (prev != null && cur != null && prev - cur >= VOR_TIER_GAP) {
          cut = i;
          break;
        }
      }
    } else {
      continue; // no tiering signal
    }

    const remaining = cut;
    if (remaining < 1 || remaining > CLIFF_REMAINING_MAX) continue;

    const lastIn = rows[cut - 1]!;
    const nextRow = rows[cut];
    if (!nextRow) continue; // the tier runs off the end of the board — no cliff

    let drop: number;
    let metric: "vor" | "adp";
    if (lastIn.vor != null && nextRow.vor != null) {
      drop = lastIn.vor - nextRow.vor;
      metric = "vor";
      if (drop < CLIFF_MIN_VOR_DROP) continue;
    } else if (lastIn.adp != null && nextRow.adp != null) {
      drop = nextRow.adp - lastIn.adp;
      metric = "adp";
      if (drop < CLIFF_MIN_ADP_DROP) continue;
    } else {
      continue;
    }

    cliffs.push({
      position,
      remaining,
      players: rows.slice(0, cut).map((r) => r.player.name),
      drop: Math.round(drop * 10) / 10,
      metric,
    });
  }

  return cliffs;
}

/** At least this many picks in the window before a "run" is meaningful. */
const RUN_MIN_WINDOW = 6;
/** Absolute floor on the count, on top of the "half the window" rule. */
const RUN_MIN_COUNT = 4;

/**
 * Positions that dominated the last `window` picks. `window` defaults to a
 * rough round; the CLI passes `settings.teams`.
 *
 * @param board  entries to resolve pick playerIds → positions (picks off the
 *               board are ignored)
 */
export function positionRuns(
  state: DraftState,
  board: readonly BoardEntry[],
  window = 12,
): Run[] {
  const posById = new Map(board.map((e) => [e.player.id, e.player.position]));
  const recent = state.picks.slice(-window);
  if (recent.length < RUN_MIN_WINDOW) return [];

  const tally = new Map<Position, number>();
  for (const pick of recent) {
    const pos = posById.get(pick.playerId);
    if (!pos) continue;
    tally.set(pos, (tally.get(pos) ?? 0) + 1);
  }

  const threshold = Math.max(RUN_MIN_COUNT, Math.ceil(recent.length / 2));
  const runs: Run[] = [];
  for (const [position, count] of tally) {
    if (count >= threshold) runs.push({ position, count, window: recent.length });
  }
  runs.sort((a, b) => b.count - a.count);
  return runs;
}
