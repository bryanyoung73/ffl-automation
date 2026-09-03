import type { LeagueSettings, SlotCode } from "../draft/types.js";
import type { Player } from "../lineup/types.js";
import type { PlayerIntel } from "../intel/types.js";
import type { AddDropPair, FreeAgent, PlayerValue, WaiverReport } from "./types.js";

/**
 * Pair worthwhile adds with their best legal drop — pure.
 * See docs/specs/2026-09-03-waiver-wire.md.
 */

const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);
const STREAM_POSITIONS = ["DEF", "K"] as const;

export interface PairOptions {
  week: number;
  settings: LeagueSettings;
  rosWeight: number;
  /** Min blended-value gain for a roster add/drop to be recommended. */
  margin?: number;
  /** Min this-week gain for a streaming swap. */
  streamMargin?: number;
  /** Max roster add/drop pairs to return. */
  limit?: number;
  /** Restrict to one position. */
  position?: string | null;
  intelById?: ReadonlyMap<string, PlayerIntel>;
}

function starterSlots(pos: string, settings: LeagueSettings): number {
  const dedicated = settings.starters[pos as SlotCode] ?? 0;
  const flex = FLEX_ELIGIBLE.has(pos) ? (settings.starters["W/R/T"] ?? 0) : 0;
  return dedicated + flex;
}

/** The flex slot codes this league actually starts. */
function activeFlexSlots(settings: LeagueSettings): string[] {
  return (["W/R/T", "OP"] as const).filter((s) => (settings.starters[s as SlotCode] ?? 0) > 0);
}

/** Two players compete for the same roster role: same position, or both fill a
 *  flex slot the league starts. */
function sharesRole(
  aPos: string,
  aSlots: readonly string[],
  bPos: string,
  bSlots: readonly string[],
  flex: readonly string[],
): boolean {
  if (aPos === bPos) return true;
  return flex.some((s) => aSlots.includes(s) && bSlots.includes(s));
}

/** Roster player ids that must not be dropped. */
export function protectedIds(
  roster: readonly Player[],
  settings: LeagueSettings,
  intelById?: ReadonlyMap<string, PlayerIntel>,
): Set<string> {
  const out = new Set<string>();
  const countByPos = new Map<string, number>();
  for (const p of roster) countByPos.set(p.position, (countByPos.get(p.position) ?? 0) + 1);

  for (const p of roster) {
    if (p.currentSlot === "IR") out.add(p.id);
    const intel = intelById?.get(p.id);
    if ((intel?.seasonImpact ?? 0) > 0) out.add(p.id);
    if (intel?.notes.some((n) => /rookie/i.test(n.text))) out.add(p.id);
    // No depth to spare at this position — every holder is protected.
    if ((countByPos.get(p.position) ?? 0) <= Math.max(1, starterSlots(p.position, settings))) {
      out.add(p.id);
    }
  }
  return out;
}

function topNote(intel: PlayerIntel | undefined, fallback: string): string {
  return intel?.notes[0]?.text ?? fallback;
}

export function buildAddDrops(
  fas: readonly FreeAgent[],
  faValues: ReadonlyMap<string, PlayerValue>,
  roster: readonly Player[],
  rosterValues: ReadonlyMap<string, PlayerValue>,
  opts: PairOptions,
): WaiverReport {
  const margin = opts.margin ?? 1.5;
  const streamMargin = opts.streamMargin ?? 2;
  const limit = opts.limit ?? 8;
  const posFilter = opts.position?.toUpperCase() ?? null;
  const val = (id: string, m: ReadonlyMap<string, PlayerValue>): number => m.get(id)?.blended ?? 0;

  const protectedSet = protectedIds(roster, opts.settings, opts.intelById);
  const flex = activeFlexSlots(opts.settings);

  // --- roster add/drop pairs (greedy by add value) ---
  const addPool = fas
    .filter((f) => !posFilter || f.position === posFilter)
    .filter((f) => !STREAM_POSITIONS.includes(f.position as (typeof STREAM_POSITIONS)[number]))
    .slice()
    .sort((a, b) => val(b.id, faValues) - val(a.id, faValues));

  const usedDrops = new Set<string>();
  const pairs: AddDropPair[] = [];
  for (const fa of addPool) {
    if (pairs.length >= limit) break;
    const candidates = roster.filter(
      (p) =>
        !protectedSet.has(p.id) &&
        !usedDrops.has(p.id) &&
        sharesRole(fa.position, fa.eligibleSlots, p.position, p.eligibleSlots, flex),
    );
    if (candidates.length === 0) continue;
    const drop = candidates.reduce((lo, p) =>
      val(p.id, rosterValues) < val(lo.id, rosterValues) ? p : lo,
    );
    const gain = round1(val(fa.id, faValues) - val(drop.id, rosterValues));
    if (gain < margin) continue;
    usedDrops.add(drop.id);
    pairs.push({
      add: fa,
      addValue: faValues.get(fa.id)!,
      drop: { id: drop.id, name: drop.name, position: drop.position },
      dropValue: rosterValues.get(drop.id) ?? null,
      gain,
      reason: topNote(opts.intelById?.get(fa.id), `ROS +${faValues.get(fa.id)?.rosVal ?? 0}`),
      kind: "roster",
    });
  }

  // --- streaming (DEF / K, by this-week value only) ---
  const streaming: AddDropPair[] = [];
  for (const pos of STREAM_POSITIONS) {
    if (posFilter && posFilter !== pos) continue;
    const best = fas
      .filter((f) => f.position === pos)
      .sort((a, b) => (faValues.get(b.id)?.weekVal ?? 0) - (faValues.get(a.id)?.weekVal ?? 0))[0];
    if (!best) continue;
    const current = roster.find((p) => p.position === pos);
    const curWeek = current ? val2(current.id, rosterValues, "weekVal") : 0;
    const gain = round1((faValues.get(best.id)?.weekVal ?? 0) - curWeek);
    if (gain < streamMargin) continue;
    streaming.push({
      add: best,
      addValue: faValues.get(best.id)!,
      drop: current ? { id: current.id, name: current.name, position: pos } : null,
      dropValue: current ? rosterValues.get(current.id) ?? null : null,
      gain,
      reason: topNote(opts.intelById?.get(best.id), `${best.team} matchup`),
      kind: "streaming",
    });
  }

  // --- positions where the pool doesn't beat your bench ---
  const paired = new Set([...pairs, ...streaming].map((p) => p.add.position));
  const skippedPositions: string[] = [];
  for (const pos of Object.keys(opts.settings.starters)) {
    if (pos === "W/R/T" || paired.has(pos)) continue;
    const bestFa = Math.max(
      0,
      ...fas.filter((f) => f.position === pos).map((f) => val(f.id, faValues)),
    );
    const bestBench = Math.max(
      0,
      ...roster.filter((p) => p.position === pos).map((p) => val(p.id, rosterValues)),
    );
    if (bestFa > 0 && bestFa <= bestBench) skippedPositions.push(pos);
  }

  return {
    week: opts.week,
    rosWeight: opts.rosWeight,
    pairs,
    streaming,
    skippedPositions,
    intelAsOf: "",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function val2(id: string, m: ReadonlyMap<string, PlayerValue>, key: "weekVal" | "rosVal"): number {
  return m.get(id)?.[key] ?? 0;
}
