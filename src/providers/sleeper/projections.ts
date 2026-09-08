import { cachedJson } from "../../intel/cache.js";
import type { LeagueSettings } from "../../draft/types.js";

/**
 * Season projections from Sleeper's own API (`api.sleeper.com/projections`,
 * note the `.com` — separate from the read API). Each row carries scoring-
 * matched season totals (`pts_ppr` / `pts_half_ppr` / `pts_std`) keyed by the
 * same player ids as the `/players/nfl` dump, so the join is exact — no scrape,
 * no name matching. Feeds `BoardEntry.projectedPoints` → VOR.
 */

const PTS_FIELD: Record<LeagueSettings["scoring"], string> = {
  ppr: "pts_ppr",
  "half-ppr": "pts_half_ppr",
  standard: "pts_std",
};

const POSITIONS_QS = ["QB", "RB", "WR", "TE", "K", "DEF"]
  .map((p) => `position%5B%5D=${p}`)
  .join("&");

interface RawProjection {
  player_id?: string;
  stats?: Record<string, number | undefined>;
}

/** Season projected points per Sleeper player id, for the given scoring. */
export function parseProjections(
  raw: unknown,
  scoring: LeagueSettings["scoring"],
): Map<string, number> {
  const field = PTS_FIELD[scoring];
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw as RawProjection[]) {
    const id = r.player_id;
    const pts = r.stats?.[field];
    if (!id || typeof pts !== "number" || !Number.isFinite(pts) || pts <= 0) continue;
    out.set(String(id), Math.round(pts * 10) / 10);
  }
  return out;
}

const TTL_MS = 12 * 60 * 60 * 1000;

export async function fetchSleeperProjections(
  cacheDir: string,
  season: number,
  scoring: LeagueSettings["scoring"],
): Promise<Map<string, number>> {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}` +
    `?season_type=regular&order_by=pts_ppr&${POSITIONS_QS}`;
  // One fetch serves every scoring — the raw rows carry all three pts fields.
  const raw = await cachedJson<unknown>(cacheDir, `sleeper-proj-${season}.json`, url, {
    ttlMs: TTL_MS,
  });
  return parseProjections(raw ?? [], scoring);
}
