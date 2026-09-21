import type { Config } from "../config.js";
import type { LineupPlan } from "../lineup/types.js";
import { appendSnapshot, trackingDataDir, type Snapshot } from "./store.js";

/** Pure: a computed plan -> the snapshot shape that gets persisted. */
export function buildSnapshot(week: number, plan: LineupPlan, fetchedAt = new Date().toISOString()): Snapshot {
  return {
    week,
    fetchedAt,
    assignments: plan.assignments
      .filter((a): a is typeof a & { player: NonNullable<typeof a.player> } => a.player !== null)
      .map((a) => ({ slotCode: a.slot.code, playerId: a.player.id, playerName: a.player.name })),
  };
}

/**
 * Record what the optimizer just recommended, for later grading against what
 * actually got played (phase 2). Called every time a plan is computed — CLI
 * or dashboard, whether or not it's acted on — since the recommendation
 * existed the moment it was shown, not only if it was submitted.
 *
 * Never throws: a disk-write hiccup here must not break the primary
 * lineup-computation flow. Skips silently (with a console warning) when the
 * week isn't known — an unfiled snapshot is useless for grading anyway.
 */
export function recordSnapshot(config: Config, week: number | undefined, plan: LineupPlan): void {
  if (!week) {
    console.warn("tracking: skipped recording snapshot — week is unknown");
    return;
  }
  try {
    const season = config.espn?.season ?? new Date().getFullYear();
    appendSnapshot(trackingDataDir(config), season, buildSnapshot(week, plan));
  } catch (err) {
    console.warn(`tracking: failed to record snapshot — ${(err as Error).message}`);
  }
}
