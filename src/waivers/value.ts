import type { LeagueSettings, SlotCode } from "../draft/types.js";
import type { PlayerIntel } from "../intel/types.js";
import { impactMultiplier } from "../intel/apply.js";
import type { PlayerValue } from "./types.js";

/**
 * Blended waiver value — pure. Every add/drop decision sorts on `blended`.
 * See docs/specs/2026-09-03-waiver-wire.md.
 */

export interface ValueInput {
  id: string;
  position: string;
  /** Projected points, target week. */
  weekProj: number;
  /** Projected points, full season. */
  seasonProj: number;
  /** Points scored so far this season (0 early). */
  actualSoFar: number;
  /** Rostered-% momentum (0 for your own players — we don't fetch it there). */
  pctChange?: number;
}

export interface ValueOptions {
  settings: LeagueSettings;
  /** Chatter/news intel keyed by player id. */
  intelById?: ReadonlyMap<string, PlayerIntel>;
  /** ROS weight in the blend: 1 = pure rest-of-season, 0 = pure this week. */
  rosWeight?: number;
}

const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);
/** Season points a point of seasonImpact is worth when nudging ROS value. */
const SEASON_PTS_PER_IMPACT = 6;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Rest-of-season projection = full-season projection minus what's banked. */
export function rosProjection(seasonProj: number, actualSoFar: number): number {
  return Math.max(0, round2(seasonProj - actualSoFar));
}

/** How many league-wide starting slots a position competes for (incl. its flex share). */
function starterSlots(pos: string, settings: LeagueSettings): number {
  const dedicated = settings.starters[pos as SlotCode] ?? 0;
  const flex = FLEX_ELIGIBLE.has(pos) ? (settings.starters["W/R/T"] ?? 0) : 0;
  return dedicated + flex;
}

/**
 * Replacement-level ROS points per position: the ROS projection of the player
 * ranked just past the last league-wide starter at that position.
 */
export function positionalReplacement(
  players: readonly ValueInput[],
  settings: LeagueSettings,
): Map<string, number> {
  const byPos = new Map<string, number[]>();
  for (const p of players) {
    const ros = rosProjection(p.seasonProj, p.actualSoFar);
    const list = byPos.get(p.position);
    if (list) list.push(ros);
    else byPos.set(p.position, [ros]);
  }
  const out = new Map<string, number>();
  for (const [pos, list] of byPos) {
    list.sort((a, b) => b - a);
    const idx = settings.teams * Math.max(1, starterSlots(pos, settings));
    out.set(pos, list[idx] ?? list[list.length - 1] ?? 0);
  }
  return out;
}

export function valuePlayers(
  players: readonly ValueInput[],
  opts: ValueOptions,
): Map<string, PlayerValue> {
  const w = clamp(opts.rosWeight ?? 0.7, 0, 1);
  const replacement = positionalReplacement(players, opts.settings);

  const out = new Map<string, PlayerValue>();
  for (const p of players) {
    const intel = opts.intelById?.get(p.id);
    const ros = rosProjection(p.seasonProj, p.actualSoFar);
    const rosVal = round2(
      ros - (replacement.get(p.position) ?? 0) + (intel?.seasonImpact ?? 0) * SEASON_PTS_PER_IMPACT,
    );
    const weekVal = round2(p.weekProj * impactMultiplier(intel?.weekImpact ?? 0));
    const buzz = round2(clamp((p.pctChange ?? 0) * 15, 0, 3));
    const blended = round2(w * rosVal + (1 - w) * weekVal + buzz);
    out.set(p.id, { id: p.id, rosVal, weekVal, buzz, blended });
  }
  return out;
}
