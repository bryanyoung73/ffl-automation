import { cachedJson } from "../../intel/cache.js";
import type { LeagueSettings } from "../../draft/types.js";

/**
 * Projections and stats from Sleeper's own API (`api.sleeper.com`, note the
 * `.com` — separate from the read API). Every row carries scoring-matched
 * totals (`pts_ppr` / `pts_half_ppr` / `pts_std`) keyed by the same player ids
 * as the `/players/nfl` dump, so the join is exact — no scrape, no name match.
 *
 * - season projections → `BoardEntry.projectedPoints` (VOR)
 * - weekly projections → `Player.projectedPoints` (lineup) / `FreeAgent.weekProj`
 * - season stats (actuals) → `pointsSoFar` / `actualSoFar` (waiver ROS)
 */

const PTS_FIELD: Record<LeagueSettings["scoring"], string> = {
  ppr: "pts_ppr",
  "half-ppr": "pts_half_ppr",
  standard: "pts_std",
};

const POSITIONS_QS = ["QB", "RB", "WR", "TE", "K", "DEF"]
  .map((p) => `position%5B%5D=${p}`)
  .join("&");

interface StatRow {
  player_id?: string;
  stats?: Record<string, number | undefined>;
}

/** Points per Sleeper player id for the given scoring, from a projections or
 *  stats response (identical row shape). */
export function parseProjections(
  raw: unknown,
  scoring: LeagueSettings["scoring"],
): Map<string, number> {
  const field = PTS_FIELD[scoring];
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw as StatRow[]) {
    const id = r.player_id;
    const pts = r.stats?.[field];
    if (!id || typeof pts !== "number" || !Number.isFinite(pts) || pts <= 0) continue;
    out.set(String(id), Math.round(pts * 10) / 10);
  }
  return out;
}

async function fetchRows(
  cacheDir: string,
  name: string,
  url: string,
  scoring: LeagueSettings["scoring"],
  ttlMs: number,
): Promise<Map<string, number>> {
  const raw = await cachedJson<unknown>(cacheDir, name, url, { ttlMs });
  return parseProjections(raw ?? [], scoring);
}

const HOUR = 60 * 60 * 1000;
const BASE = "https://api.sleeper.com";
const QS = `season_type=regular&order_by=pts_ppr&${POSITIONS_QS}`;

/** Full-season projections. */
export function fetchSleeperProjections(
  cacheDir: string,
  season: number,
  scoring: LeagueSettings["scoring"],
): Promise<Map<string, number>> {
  return fetchRows(cacheDir, `sleeper-proj-${season}.json`, `${BASE}/projections/nfl/${season}?${QS}`, scoring, 12 * HOUR);
}

/** One week's projections. */
export function fetchSleeperWeeklyProjections(
  cacheDir: string,
  season: number,
  week: number,
  scoring: LeagueSettings["scoring"],
): Promise<Map<string, number>> {
  return fetchRows(
    cacheDir,
    `sleeper-proj-${season}-w${week}.json`,
    `${BASE}/projections/nfl/${season}/${week}?${QS}`,
    scoring,
    3 * HOUR,
  );
}

/** Season-to-date actual fantasy points. */
export function fetchSleeperSeasonStats(
  cacheDir: string,
  season: number,
  scoring: LeagueSettings["scoring"],
): Promise<Map<string, number>> {
  return fetchRows(cacheDir, `sleeper-stats-${season}.json`, `${BASE}/stats/nfl/${season}?${QS}`, scoring, 6 * HOUR);
}
