import { cachedJson } from "./cache.js";
import { normalizeName, teamCode } from "../nfl/names.js";
import type { IntelPlayerRef, PlayerIdentity } from "./types.js";

export { normalizeName, teamCode } from "../nfl/names.js";

/**
 * Cross-provider player identity. Sleeper's `/players/nfl` dump carries both
 * `espn_id` and `yahoo_id`, so we match each roster/board player to a Sleeper
 * record (by normalized name + team/position) and read the other ids off it.
 *
 * `buildIdentityMap` is pure and unit-tested; `loadSleeperPlayers` is the only
 * impure part. Name/team normalization lives in `src/nfl/names.ts`.
 */

export interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  team?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  practice_description?: string | null;
  news_updated?: number | null;
  active?: boolean;
  depth_chart_order?: number | null;
  depth_chart_position?: string | null;
  age?: number | null;
  years_exp?: number | null;
}

function idStr(v: number | string | null | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  return String(v);
}

function sleeperName(p: SleeperPlayer): string {
  if (p.full_name) return p.full_name;
  return [p.first_name, p.last_name].filter(Boolean).join(" ");
}

/**
 * Build `inputPlayerId -> PlayerIdentity`. Defenses match on team + DEF;
 * everyone else on normalized name + team, then name + position, then name.
 */
export function buildIdentityMap(
  players: readonly IntelPlayerRef[],
  sleeper: readonly SleeperPlayer[],
): Map<string, PlayerIdentity> {
  const byNameTeam = new Map<string, SleeperPlayer>();
  const byNamePos = new Map<string, SleeperPlayer>();
  const byName = new Map<string, SleeperPlayer>();
  const defByTeam = new Map<string, SleeperPlayer>();

  for (const sp of sleeper) {
    const pos = (sp.position ?? "").toUpperCase();
    const team = teamCode(sp.team);
    if (pos === "DEF") {
      if (team) defByTeam.set(team, sp);
      continue;
    }
    const n = normalizeName(sleeperName(sp));
    if (!n) continue;
    if (team) byNameTeam.set(`${n}|${team}`, sp);
    if (pos) byNamePos.set(`${n}|${pos}`, sp);
    if (!byName.has(n)) byName.set(n, sp);
  }

  const out = new Map<string, PlayerIdentity>();
  for (const p of players) {
    const base: PlayerIdentity = {
      id: p.id,
      name: p.name,
      team: teamCode(p.team),
      position: (p.position ?? "").toUpperCase(),
    };
    let sp: SleeperPlayer | undefined;
    if (base.position === "DEF" || base.position === "DST") {
      sp = defByTeam.get(base.team);
    } else {
      const n = normalizeName(p.name);
      sp =
        byNameTeam.get(`${n}|${base.team}`) ??
        byNamePos.get(`${n}|${base.position}`) ??
        byName.get(n);
    }
    if (sp) {
      base.sleeperId = sp.player_id;
      base.espnId = idStr(sp.espn_id);
      base.yahooId = idStr(sp.yahoo_id);
    }
    out.set(p.id, base);
  }
  return out;
}

const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
/** The dump is ~5 MB and changes slowly — cache it for a day. */
const SLEEPER_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadSleeperPlayers(
  cacheDir: string,
  opts: { force?: boolean } = {},
): Promise<SleeperPlayer[]> {
  const raw = await cachedJson<Record<string, SleeperPlayer>>(
    cacheDir,
    "sleeper-players.json",
    SLEEPER_PLAYERS_URL,
    { ttlMs: SLEEPER_TTL_MS, force: opts.force },
  );
  if (!raw) return [];
  return Object.values(raw).filter((p) => p && p.player_id);
}
