import type { Config } from "../config.js";
import type { LeagueSettings } from "../draft/types.js";
import { intelCacheDir } from "../intel/collect.js";
import { loadSleeperPlayers, buildIdentityMap } from "../intel/match.js";
import { fetchSleeperProjections } from "../providers/sleeper/projections.js";

export interface SecondaryProjectionRef {
  id: string;
  name: string;
  team: string;
  position: string;
}

/**
 * An independent second opinion on rest-of-season value: Sleeper's own
 * season projections, keyed back to the active provider's player ids via
 * identity match (src/intel/match.ts). Sleeper's read API needs no auth, so
 * this works regardless of which provider is configured — except when
 * Sleeper *is* the configured provider, where the primary seasonProj already
 * is this number, so there's nothing to add and we skip the extra fetch.
 */
export async function fetchSecondarySeasonProjections(
  config: Config,
  refs: readonly SecondaryProjectionRef[],
  scoring: LeagueSettings["scoring"],
): Promise<Map<string, number>> {
  if (config.provider === "sleeper") return new Map();

  const cacheDir = intelCacheDir(config);
  const season = config.espn?.season ?? new Date().getFullYear();
  const [sleeperPlayers, seasonProj] = await Promise.all([
    loadSleeperPlayers(cacheDir),
    fetchSleeperProjections(cacheDir, season, scoring),
  ]);
  const identity = buildIdentityMap(refs, sleeperPlayers);

  const out = new Map<string, number>();
  for (const ref of refs) {
    const sleeperId = identity.get(ref.id)?.sleeperId;
    const proj = sleeperId ? seasonProj.get(sleeperId) : undefined;
    if (proj) out.set(ref.id, proj);
  }
  return out;
}
