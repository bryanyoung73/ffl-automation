import { cachedJson } from "../intel/cache.js";
import { normalizeName, teamCode } from "../nfl/names.js";
import type { BoardEntry } from "./board.js";
import type { LeagueSettings } from "./types.js";

/**
 * Average draft position from FantasyFootballCalculator's public JSON API
 * (`/api/v1/adp/<scoring>?teams=<n>&year=<season>`). No auth. It carries
 * `high` / `low` (best / worst actual draft slot) and `stdev` (observed
 * draft-slot variance) — the ceiling/floor and per-player sigma the ESPN board
 * never had.
 *
 * `parseAdp` / `attachAdp` are pure; `fetchAdp` is the only impure part. A miss
 * just leaves the board without ADP (falls back to expert rank ordering).
 */

export interface AdpEntry {
  name: string;
  team: string;
  position: string;
  adp: number;
  /** Best / worst actual draft slot across the sampled drafts. */
  high: number | null;
  low: number | null;
  /** Std dev of the draft slot — the real per-player survival sigma. */
  stdev: number | null;
  bye: number | null;
}

interface FfcResponse {
  status?: string;
  players?: Array<{
    name?: string;
    team?: string;
    position?: string;
    adp?: number;
    high?: number;
    low?: number;
    stdev?: number;
    bye?: number;
  }>;
}

const SCORING_PATH: Record<LeagueSettings["scoring"], string> = {
  ppr: "ppr",
  "half-ppr": "half-ppr",
  standard: "standard",
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a FantasyFootballCalculator `/api/v1/adp` response to `AdpEntry[]`. */
export function parseAdp(raw: unknown): AdpEntry[] {
  const data = raw as FfcResponse | null;
  if (!data || !Array.isArray(data.players)) return [];
  const out: AdpEntry[] = [];
  for (const p of data.players) {
    const name = (p.name ?? "").trim();
    const adp = num(p.adp);
    if (!name || adp == null || adp <= 0) continue;
    out.push({
      name,
      team: teamCode(p.team),
      position: (p.position ?? "").toUpperCase(),
      adp,
      high: num(p.high),
      low: num(p.low),
      stdev: num(p.stdev),
      bye: num(p.bye),
    });
  }
  return out;
}

/**
 * Attach ADP to board entries by normalized name (+ team tiebreak); defenses
 * join on team code. Returns new entries; match count on `.matched`.
 */
export function attachAdp(
  entries: readonly BoardEntry[],
  adp: readonly AdpEntry[],
): { entries: BoardEntry[]; matched: number } {
  const byNameTeam = new Map<string, AdpEntry>();
  const byName = new Map<string, AdpEntry>();
  const defByTeam = new Map<string, AdpEntry>();
  for (const a of adp) {
    if (a.position === "DEF") {
      if (a.team) defByTeam.set(a.team, a);
      continue;
    }
    const n = normalizeName(a.name);
    if (a.team) byNameTeam.set(`${n}|${a.team}`, a);
    if (!byName.has(n)) byName.set(n, a);
  }

  let matched = 0;
  const out = entries.map((e) => {
    const team = teamCode(e.player.team);
    const hit =
      e.player.position === "DEF"
        ? defByTeam.get(team)
        : byNameTeam.get(`${normalizeName(e.player.name)}|${team}`) ??
          byName.get(normalizeName(e.player.name));
    if (!hit) return e;
    matched++;
    return {
      ...e,
      player:
        e.player.bye == null && hit.bye != null
          ? { ...e.player, bye: hit.bye }
          : e.player,
      adp: hit.adp,
      adpHigh: hit.high,
      adpLow: hit.low,
      adpStdev: hit.stdev,
    };
  });
  return { entries: out, matched };
}

const ADP_TTL_MS = 8 * 60 * 60 * 1000;

export async function fetchAdp(
  cacheDir: string,
  scoring: LeagueSettings["scoring"],
  teams: number,
  season: number,
  opts: { force?: boolean } = {},
): Promise<AdpEntry[]> {
  const path = SCORING_PATH[scoring];
  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${path}?teams=${teams}&year=${season}`;
  const raw = await cachedJson<unknown>(
    cacheDir,
    `ffc-adp-${path}-${teams}-${season}.json`,
    url,
    { ttlMs: ADP_TTL_MS, force: opts.force },
  );
  return raw ? parseAdp(raw) : [];
}
