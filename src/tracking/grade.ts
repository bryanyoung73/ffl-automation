import { isStartingSlot } from "../lineup/optimizer.js";
import type { Player } from "../lineup/types.js";
import type { Snapshot } from "./store.js";

/**
 * Grading — pure. Compares the *set* of players a snapshot recommended
 * against the *set* actually started that week, both scored by real (not
 * projected) points. Deliberately set-based, not slot-index-based: which
 * exact "RB2" vs "FLEX" label a player holds is cosmetic (the optimizer
 * itself treats these as interchangeable — see optimizer.ts's flex
 * tie-break), so grading on exact slot position would falsely flag a
 * same-players-different-label lineup as a disagreement.
 */

/** The snapshot to grade: the latest one strictly before the week's first
 *  lock. Undefined if every snapshot for the week came after the lock (no
 *  pre-lock recommendation exists to grade fairly). */
export function selectRecommendedSnapshot(
  snapshots: readonly Snapshot[],
  firstLockAt: string,
): Snapshot | undefined {
  const before = snapshots.filter((s) => s.fetchedAt < firstLockAt);
  if (before.length === 0) return undefined;
  return before.reduce((latest, s) => (s.fetchedAt > latest.fetchedAt ? s : latest));
}

export interface PlayerScore {
  id: string;
  name: string;
  points: number;
}

export interface WeekGrade {
  week: number;
  recommendedTotal: number;
  actualTotal: number;
  /** actualTotal - recommendedTotal. Negative = the actual lineup scored
   *  fewer points than the recommendation would have. */
  delta: number;
  /** Players in both sets. */
  agreementCount: number;
  recommendedCount: number;
  agreementRate: number;
  /** Recommended but not actually started, with what they scored. */
  onlyRecommended: PlayerScore[];
  /** Actually started but not recommended, with what they scored. */
  onlyActual: PlayerScore[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Rates (0-1 fractions) get finer precision than point totals — 1 decimal
 *  on a rate throws away too much (0.933 and 0.85 would both read "0.9"). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `actualPlayers` is a completed week's full roster (starters + bench),
 * i.e. `LeagueProvider.getWeekResult(week).players` — real per-week slots
 * and `livePoints` (see `weeklyActualPoints`), not the current roster.
 */
export function gradeWeek(recommended: Snapshot, actualPlayers: readonly Player[]): WeekGrade {
  const pointsById = new Map(actualPlayers.map((p) => [p.id, p.livePoints ?? 0]));
  const nameById = new Map(actualPlayers.map((p) => [p.id, p.name]));

  const recommendedIds = new Set(recommended.assignments.map((a) => a.playerId));
  const actualStarters = actualPlayers.filter((p) => isStartingSlot(p.currentSlot));
  const actualIds = new Set(actualStarters.map((p) => p.id));

  const scoreOf = (id: string, fallbackName: string): PlayerScore => ({
    id,
    name: nameById.get(id) ?? fallbackName,
    points: pointsById.get(id) ?? 0,
  });

  const recommendedTotal = round1(
    recommended.assignments.reduce((sum, a) => sum + (pointsById.get(a.playerId) ?? 0), 0),
  );
  const actualTotal = round1(actualStarters.reduce((sum, p) => sum + (p.livePoints ?? 0), 0));

  const onlyRecommended = recommended.assignments
    .filter((a) => !actualIds.has(a.playerId))
    .map((a) => scoreOf(a.playerId, a.playerName));
  const onlyActual = actualStarters
    .filter((p) => !recommendedIds.has(p.id))
    .map((p) => scoreOf(p.id, p.name));

  const recommendedCount = recommended.assignments.length;
  const agreementCount = recommendedCount - onlyRecommended.length;

  return {
    week: recommended.week,
    recommendedTotal,
    actualTotal,
    delta: round1(actualTotal - recommendedTotal),
    agreementCount,
    recommendedCount,
    agreementRate: recommendedCount ? round2(agreementCount / recommendedCount) : 0,
    onlyRecommended,
    onlyActual,
  };
}

export interface SeasonSummary {
  weeks: WeekGrade[];
  avgAgreementRate: number;
  avgDelta: number;
  /** delta < 0: the recommendation would have scored more. */
  weeksRecommendationWasBetter: number;
  /** delta > 0: what was actually played scored more. */
  weeksActualWasBetter: number;
  weeksTied: number;
}

export function summarizeSeason(weeks: readonly WeekGrade[]): SeasonSummary {
  if (weeks.length === 0) {
    return {
      weeks: [],
      avgAgreementRate: 0,
      avgDelta: 0,
      weeksRecommendationWasBetter: 0,
      weeksActualWasBetter: 0,
      weeksTied: 0,
    };
  }
  const avgAgreementRate = round2(weeks.reduce((s, w) => s + w.agreementRate, 0) / weeks.length);
  const avgDelta = round1(weeks.reduce((s, w) => s + w.delta, 0) / weeks.length);
  const weeksRecommendationWasBetter = weeks.filter((w) => w.delta < 0).length;
  const weeksActualWasBetter = weeks.filter((w) => w.delta > 0).length;
  return {
    weeks: [...weeks],
    avgAgreementRate,
    avgDelta,
    weeksRecommendationWasBetter,
    weeksActualWasBetter,
    weeksTied: weeks.length - weeksRecommendationWasBetter - weeksActualWasBetter,
  };
}
