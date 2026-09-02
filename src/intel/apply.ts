import type { Player } from "../lineup/types.js";
import type { BoardEntry } from "../draft/board.js";
import type { Horizon, IntelNote, PartialIntel, PlayerIntel } from "./types.js";

/* ------------------------------------------------------------------ *
 * Merge — combine per-provider partials into one PlayerIntel per player.
 * Pure.
 * ------------------------------------------------------------------ */

const clamp3 = (n: number): number => Math.max(-3, Math.min(3, n));

/** `providerResults` is one map per provider: playerId -> PartialIntel. */
export function mergeIntel(
  providerResults: ReadonlyArray<ReadonlyMap<string, PartialIntel>>,
): Map<string, PlayerIntel> {
  const byPlayer = new Map<string, PartialIntel[]>();
  for (const result of providerResults) {
    for (const [id, part] of result) {
      const list = byPlayer.get(id);
      if (list) list.push(part);
      else byPlayer.set(id, [part]);
    }
  }

  const out = new Map<string, PlayerIntel>();
  for (const [id, parts] of byPlayer) {
    const notes = parts
      .flatMap((p) => p.notes ?? [])
      .sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? ""));
    const seasonImpact = clamp3(parts.reduce((s, p) => s + (p.seasonImpact ?? 0), 0));
    const weekImpact = clamp3(parts.reduce((s, p) => s + (p.weekImpact ?? 0), 0));
    const confidence = Math.max(0, ...parts.map((p) => p.confidence ?? 0));
    out.set(id, {
      playerKey: id,
      notes,
      seasonImpact,
      weekImpact,
      confidence,
      asOf: notes.find((n) => n.asOf)?.asOf ?? "",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Weekly — nudge effective projected points before the optimizer runs.
 * Pure.
 * ------------------------------------------------------------------ */

export interface ProjectionAdjustment {
  id: string;
  name: string;
  from: number;
  to: number;
  delta: number;
  impact: number;
  notes: IntelNote[];
}

export interface AdjustResult {
  players: Player[];
  adjustments: ProjectionAdjustment[];
}

/**
 * Multiplier for a -3..+3 impact. Mild around zero (Questionable ~= -10%),
 * but an Out-level signal (<= -2.5) collapses the projection so the optimizer
 * benches the player on its own.
 */
export function impactMultiplier(impact: number): number {
  if (impact <= -2.5) return 0.15;
  return Math.max(0.4, Math.min(1.4, 1 + impact * 0.15));
}

function pickImpact(intel: PlayerIntel, horizon: Horizon): number {
  return horizon === "season" ? intel.seasonImpact : intel.weekImpact;
}

export function adjustProjections(
  players: readonly Player[],
  intelById: ReadonlyMap<string, PlayerIntel>,
  opts: { horizon: Horizon } = { horizon: "week" },
): AdjustResult {
  const adjustments: ProjectionAdjustment[] = [];
  const adjusted = players.map((p) => {
    const intel = intelById.get(p.id);
    if (!intel) return p;
    const impact = pickImpact(intel, opts.horizon);
    if (impact === 0 && intel.notes.length === 0) return p;

    const from = p.projectedPoints;
    const to = Math.round(from * impactMultiplier(impact) * 10) / 10;
    if (to !== from || intel.notes.length > 0) {
      adjustments.push({
        id: p.id,
        name: p.name,
        from,
        to,
        delta: Math.round((to - from) * 10) / 10,
        impact,
        notes: intel.notes,
      });
    }
    return to === from ? p : { ...p, projectedPoints: to };
  });
  return { players: adjusted, adjustments };
}

/* ------------------------------------------------------------------ *
 * Draft — attach notes to board entries (Phase 2 wires the CLI).
 * Pure.
 * ------------------------------------------------------------------ */

export interface AnnotatedBoardEntry extends BoardEntry {
  intel?: PlayerIntel;
}

export function annotateBoard(
  entries: readonly BoardEntry[],
  intelById: ReadonlyMap<string, PlayerIntel>,
): AnnotatedBoardEntry[] {
  return entries.map((e) => {
    const intel = intelById.get(e.player.id);
    return intel ? { ...e, intel } : { ...e };
  });
}
