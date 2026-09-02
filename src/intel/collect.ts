import { resolve } from "node:path";
import type { Config } from "../config.js";
import { readCache, writeCache } from "./cache.js";
import { buildIdentityMap, loadSleeperPlayers } from "./match.js";
import { mergeIntel } from "./apply.js";
import { sleeperProvider } from "./providers/sleeper.js";
import { espnNewsProvider } from "./providers/espnNews.js";
import type { IntelContext, IntelPlayerRef, IntelProvider, PlayerIntel } from "./types.js";

const PROVIDERS: IntelProvider[] = [sleeperProvider, espnNewsProvider];

/** Merged intel keyed by input player id, plus when it was gathered. */
export interface IntelBundle {
  intel: Map<string, PlayerIntel>;
  fetchedAt: string;
  week: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

interface CachedBundle {
  fetchedAt: string;
  week: number;
  intel: Record<string, PlayerIntel>;
}

export function intelCacheDir(config: Config): string {
  return resolve(config.projectRoot, ".cache");
}

/**
 * Gather intel for `players`. Serves a fresh-enough on-disk bundle unless
 * `force`; otherwise runs every provider, merges, and caches the result.
 */
export async function collectIntel(
  config: Config,
  players: readonly IntelPlayerRef[],
  opts: { week?: number; force?: boolean; ttlMs?: number; scope?: string } = {},
): Promise<IntelBundle> {
  const cacheDir = intelCacheDir(config);
  const week = opts.week ?? config.week ?? 0;
  const season = config.espn?.season ?? new Date().getFullYear();
  // `scope` separates callers with different player sets (weekly roster vs the
  // ~80-deep draft board) so one doesn't serve the other a thin cache.
  const cacheName = `intel-${season}-${opts.scope ?? `wk${week}`}.json`;

  if (!opts.force) {
    const hit = readCache<CachedBundle>(cacheDir, cacheName, opts.ttlMs ?? DEFAULT_TTL_MS);
    if (hit) {
      return {
        intel: new Map(Object.entries(hit.intel)),
        fetchedAt: hit.fetchedAt,
        week: hit.week,
      };
    }
  }

  const sleeper = await loadSleeperPlayers(cacheDir, { force: opts.force });
  const identityMap = buildIdentityMap(players, sleeper);

  const ctx: IntelContext = {
    players,
    week,
    season,
    identity: (id) => identityMap.get(id),
    cacheDir,
  };

  const results = await Promise.all(
    PROVIDERS.map((p) =>
      p.collect(ctx).catch((err: unknown) => {
        console.warn(`intel: ${p.name} failed — ${(err as Error).message}`);
        return new Map();
      }),
    ),
  );

  const intel = mergeIntel(results);
  const fetchedAt = new Date().toISOString();

  writeCache<CachedBundle>(cacheDir, cacheName, {
    fetchedAt,
    week,
    intel: Object.fromEntries(intel),
  });

  return { intel, fetchedAt, week };
}
