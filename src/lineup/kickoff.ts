import { teamCode } from "../intel/match.js";
import { intelCacheDir } from "../intel/collect.js";
import { fetchKickoffTimes } from "../intel/providers/vegas.js";
import type { Config } from "../config.js";
import type { Player } from "./types.js";

/**
 * Attach each player's game kickoff time (ISO), when known, from ESPN's
 * public scoreboard — provider-agnostic (works regardless of PROVIDER), used
 * only by `optimizeLineup`'s flex-slot tie-break (see optimizer.ts). Never
 * throws: a fetch failure or an unmatched team just leaves `kickoffAt` unset,
 * degrading gracefully back to the optimizer's old deterministic tiebreak.
 */
export async function attachKickoffTimes(
  config: Config,
  players: readonly Player[],
  week: number | undefined,
): Promise<Player[]> {
  const season = config.espn?.season ?? new Date().getFullYear();
  const kickoffByTeam = await fetchKickoffTimes(intelCacheDir(config), season, week ?? 0);
  if (kickoffByTeam.size === 0) return [...players];
  return players.map((p) => {
    const kickoffAt = kickoffByTeam.get(teamCode(p.team));
    return kickoffAt ? { ...p, kickoffAt } : p;
  });
}
