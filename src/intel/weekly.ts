import type { Config } from "../config.js";
import type { Player } from "../lineup/types.js";
import { collectIntel } from "./collect.js";
import { adjustProjections, type ProjectionAdjustment } from "./apply.js";

export interface WeeklyIntelResult {
  players: Player[];
  adjustments: ProjectionAdjustment[];
  /** ISO time the intel bundle was gathered, or "" when skipped. */
  fetchedAt: string;
  skipped: boolean;
}

/**
 * The shared `roster` / `lineup` entry point: gather intel for the roster and
 * return players with projected points nudged for this week. `skip` (from
 * `--no-intel`) passes players straight through.
 */
export async function applyWeeklyIntel(
  config: Config,
  players: readonly Player[],
  opts: { skip?: boolean; force?: boolean; llm?: boolean } = {},
): Promise<WeeklyIntelResult> {
  if (opts.skip) {
    return { players: [...players], adjustments: [], fetchedAt: "", skipped: true };
  }
  const bundle = await collectIntel(config, players, { force: opts.force, llm: opts.llm });
  const { players: adjusted, adjustments } = adjustProjections(players, bundle.intel, {
    horizon: "week",
  });
  return { players: adjusted, adjustments, fetchedAt: bundle.fetchedAt, skipped: false };
}

/** One line per adjusted player, newest note inline. */
export function formatAdjustments(adjustments: readonly ProjectionAdjustment[]): string[] {
  return adjustments.map((a) => {
    const move =
      a.delta === 0
        ? `${a.from.toFixed(1)}`
        : `${a.from.toFixed(1)} -> ${a.to.toFixed(1)} (${a.delta > 0 ? "+" : ""}${a.delta.toFixed(1)})`;
    const note = a.notes[0]?.text ? ` · ${a.notes[0]!.text}` : "";
    return `  ${a.name}  ${move}${note}`;
  });
}
