import type { PlayerStatus } from "../../lineup/types.js";

/**
 * ESPN Fantasy v3 id/code lookups + a few pure extractors.
 *
 * Values are seeded from the community `espn-api` constants and then verified
 * against a live roster dump (see docs/specs/2026-08-31-espn-api-provider.md).
 * Everything here is pure and unit-tested in tests/espn-maps.spec.ts.
 */

/** NFL team id -> abbreviation. `0` is free agent / none. */
export const PRO_TEAM_ABBR: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export function proTeamAbbr(id: number | null | undefined): string {
  if (id == null) return "";
  return PRO_TEAM_ABBR[id] ?? "";
}

/**
 * Lineup slot id -> internal slot code. Offensive flex variants (RB/WR, WR/TE,
 * OP/superflex, RB/WR/TE) collapse to "W/R/T". IDP slots keep their own codes
 * ("LB", "DL", "DB", ...) so IDP leagues don't silently lose starting slots;
 * the pure optimizer treats any code generically.
 */
export const SLOT_CODE_BY_ID: Record<number, string> = {
  0: "QB",
  1: "QB", // TQB
  2: "RB",
  3: "W/R/T", // RB/WR
  4: "WR",
  5: "W/R/T", // WR/TE
  6: "TE",
  7: "W/R/T", // OP / superflex
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP", // defensive player (any IDP)
  16: "DEF", // D/ST
  17: "K",
  18: "P",
  19: "HC",
  20: "BN",
  21: "IR",
  23: "W/R/T", // FLEX (RB/WR/TE)
  24: "BN", // ER (extra reserve)
};

export function slotCode(id: number | null | undefined): string {
  if (id == null) return "BN";
  return SLOT_CODE_BY_ID[id] ?? "BN";
}

/** `player.defaultPositionId` -> primary position (ESPN's own scheme). */
export const POSITION_BY_DEFAULT_ID: Record<number, string> = {
  0: "QB", 1: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
};

/** Primary-position lineup slot ids, most specific first, for slot-based derivation. */
const PRIMARY_SLOT_TO_POSITION: ReadonlyArray<[number, string]> = [
  [0, "QB"], [2, "RB"], [4, "WR"], [6, "TE"], [17, "K"], [16, "DEF"],
  [8, "DT"], [9, "DE"], [10, "LB"], [12, "CB"], [13, "S"], [11, "DL"], [14, "DB"],
];

/**
 * Best-effort primary position. Prefers a match among the player's eligible
 * lineup slots (unambiguous), falling back to `defaultPositionId`.
 */
export function derivePosition(
  eligibleSlots: readonly number[] | null | undefined,
  defaultPositionId: number | null | undefined,
): string {
  if (eligibleSlots) {
    for (const [slotId, pos] of PRIMARY_SLOT_TO_POSITION) {
      if (eligibleSlots.includes(slotId)) return pos;
    }
  }
  if (defaultPositionId != null && POSITION_BY_DEFAULT_ID[defaultPositionId]) {
    return POSITION_BY_DEFAULT_ID[defaultPositionId]!;
  }
  return "WR";
}

/** Eligible lineup slot ids -> the slot codes the optimizer understands. */
export function eligibleSlotCodes(eligibleSlots: readonly number[] | null | undefined): string[] {
  if (!eligibleSlots) return [];
  const out = new Set<string>();
  for (const id of eligibleSlots) {
    const code = SLOT_CODE_BY_ID[id];
    if (code && code !== "BN" && code !== "IR") out.add(code);
  }
  return [...out];
}

const STATUS_BY_INJURY: Record<string, PlayerStatus> = {
  ACTIVE: "OK",
  NORMAL: "OK",
  PROBABLE: "OK",
  QUESTIONABLE: "Q",
  DAY_TO_DAY: "Q",
  DOUBTFUL: "D",
  OUT: "O",
  INJURY_RESERVE: "IR",
  IR: "IR",
  PHYSICALLY_UNABLE_TO_PERFORM: "PUP",
  SUSPENSION: "SUSP",
};

export function injuryStatus(raw: string | null | undefined): PlayerStatus {
  if (!raw) return "OK";
  return STATUS_BY_INJURY[raw.toUpperCase()] ?? "OK";
}

export type ScoringKind = "standard" | "half-ppr" | "ppr";

interface ScoringItem {
  statId: number;
  points?: number;
  pointsOverrides?: Record<string, number>;
}

/** Reception scoring lives on statId 53. 1 => PPR, 0.5 => half, else standard. */
export function detectScoring(scoringItems: readonly ScoringItem[] | null | undefined): ScoringKind {
  const reception = scoringItems?.find((i) => i.statId === 53);
  if (!reception) return "standard";
  const pts =
    reception.points ??
    (reception.pointsOverrides ? Object.values(reception.pointsOverrides)[0] : undefined) ??
    0;
  if (pts >= 1) return "ppr";
  if (pts > 0) return "half-ppr";
  return "standard";
}

/** The ranking bucket ESPN keys `draftRanksByRankType` on for this scoring. */
export function rankTypeForScoring(scoring: ScoringKind): "PPR" | "STANDARD" {
  return scoring === "standard" ? "STANDARD" : "PPR";
}

interface StatEntry {
  statSourceId?: number;
  statSplitTypeId?: number;
  scoringPeriodId?: number;
  seasonId?: number;
  appliedTotal?: number;
}

/**
 * Projected fantasy points for a given week. ESPN marks projections with
 * `statSourceId === 1` (0 is actual); the weekly split matches `scoringPeriodId`.
 */
export function weeklyProjectedPoints(
  stats: readonly StatEntry[] | null | undefined,
  week: number,
): number {
  const hit = stats?.find(
    (s) => s.statSourceId === 1 && s.scoringPeriodId === week,
  );
  return hit?.appliedTotal ?? 0;
}

/** Projected fantasy points for the full season (statSplitTypeId 0). */
export function seasonProjectedPoints(
  stats: readonly StatEntry[] | null | undefined,
  season?: number,
): number {
  const projected = (stats ?? []).filter(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 0,
  );
  // Multiple projected-season rows can come back (prior season + current);
  // prefer the one for `season`.
  const hit =
    (season != null && projected.find((s) => s.seasonId === season)) ||
    projected[0];
  return hit?.appliedTotal ?? 0;
}

/**
 * Build the `x-fantasy-filter` payload for a draft-board pull from
 * `kona_player_info`: the top `limit` players by draft ranking for `rankType`.
 */
export function draftBoardFilter(rankType: "PPR" | "STANDARD", limit = 300): string {
  return JSON.stringify({
    players: {
      limit,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: rankType },
    },
  });
}
