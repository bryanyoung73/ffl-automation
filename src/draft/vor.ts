import {
  POSITIONS,
  type LeagueSettings,
  type PlayerProjection,
  type Position,
  type VorResult,
} from "./types.js";

const FLEX_POSITIONS: readonly Position[] = ["RB", "WR", "TE"];

/**
 * Value over replacement for every projected player.
 *
 * Replacement level is found by simulation so the FLEX slot is allocated
 * realistically: fill every league-wide dedicated starting slot from the best
 * projections, then fill league-wide FLEX slots from the best remaining
 * RB/WR/TE. A position's replacement points = the best projection at that
 * position that did NOT land a starting slot.
 */
export function computeVor(
  projections: readonly PlayerProjection[],
  settings: LeagueSettings,
): Map<string, VorResult> {
  const byPoints = [...projections].sort(
    (a, b) => b.projectedPoints - a.projectedPoints || a.name.localeCompare(b.name),
  );

  const startedCountByPos = new Map<Position, number>(POSITIONS.map((p) => [p, 0]));
  const started = new Set<string>();

  // 1. Dedicated slots.
  for (const pos of POSITIONS) {
    const perTeam = settings.starters[pos] ?? 0;
    let need = perTeam * settings.teams;
    if (need <= 0) continue;
    for (const player of byPoints) {
      if (need === 0) break;
      if (player.position !== pos || started.has(player.id)) continue;
      started.add(player.id);
      startedCountByPos.set(pos, (startedCountByPos.get(pos) ?? 0) + 1);
      need--;
    }
  }

  // 2. FLEX slots (W/R/T) from the best remaining RB/WR/TE.
  let flexNeed = (settings.starters["W/R/T"] ?? 0) * settings.teams;
  for (const player of byPoints) {
    if (flexNeed === 0) break;
    if (started.has(player.id)) continue;
    if (!FLEX_POSITIONS.includes(player.position)) continue;
    started.add(player.id);
    startedCountByPos.set(player.position, (startedCountByPos.get(player.position) ?? 0) + 1);
    flexNeed--;
  }

  // 3. Replacement points per position = best non-starter at that position.
  const replacementByPos = new Map<Position, number>();
  for (const pos of POSITIONS) {
    const firstNonStarter = byPoints.find((p) => p.position === pos && !started.has(p.id));
    replacementByPos.set(pos, firstNonStarter?.projectedPoints ?? 0);
  }

  // 4. VOR + rank.
  const scored = projections.map((p) => ({
    id: p.id,
    vor: round2(p.projectedPoints - (replacementByPos.get(p.position) ?? 0)),
    name: p.name,
  }));
  scored.sort((a, b) => b.vor - a.vor || a.name.localeCompare(b.name));

  const result = new Map<string, VorResult>();
  scored.forEach((s, i) => result.set(s.id, { vor: s.vor, vorRank: i + 1 }));
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
