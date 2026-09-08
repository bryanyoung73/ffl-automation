import { cachedParsed } from "../intel/cache.js";
import { normalizeName, teamCode } from "../nfl/names.js";
import type { BoardEntry } from "./board.js";
import type { LeagueSettings } from "./types.js";

/**
 * FantasyPros Expert Consensus Ranking (ECR) — a real multi-ranker consensus to
 * flag against ADP, instead of one platform's single expert rank.
 *
 * Scraped from the public cheat-sheet page, which embeds the data as
 * `var ecrData = {... "players":[...] }`. `parseEcrHtml` and `attachEcr` are
 * pure and unit-tested; `fetchEcr` is the only impure part. HTML scraping is
 * brittle by nature — a miss just means the board falls back to the source's
 * own rank.
 */

export interface EcrEntry {
  name: string;
  team: string;
  position: string;
  ecrRank: number;
  posRank: string;
  tier: number;
  /** Rank movement since the last update (negative = rising). */
  delta: number | null;
  /** Best-case expert rank (rank ceiling). */
  rankMin: number | null;
  /** Worst-case expert rank (rank floor). */
  rankMax: number | null;
  /** Std dev of the expert ranks — low = tight consensus, high = boom/bust. */
  rankStd: number | null;
}

interface RawEcrPlayer {
  player_name?: string;
  player_team_id?: string;
  player_position_id?: string;
  rank_ecr?: number;
  pos_rank?: string;
  tier?: number;
  player_ecr_delta?: number | null;
  rank_min?: string | number;
  rank_max?: string | number;
  rank_std?: string | number;
}

function num(v: string | number | undefined | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const PAGE_BY_SCORING: Record<LeagueSettings["scoring"], string> = {
  ppr: "ppr-cheatsheets.php",
  "half-ppr": "half-point-ppr-cheatsheets.php",
  standard: "standard-cheatsheets.php",
};

/** Pull `var ecrData = {...};` out of the page and map its `players` array. */
export function parseEcrHtml(html: string): EcrEntry[] {
  const m = html.match(/var\s+ecrData\s*=\s*(\{.*?\})\s*;/s);
  if (!m) return [];
  let data: { players?: RawEcrPlayer[] };
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  const out: EcrEntry[] = [];
  for (const p of data.players ?? []) {
    const name = (p.player_name ?? "").trim();
    if (!name || p.rank_ecr == null) continue;
    const rank = Number(p.rank_ecr);
    if (!Number.isFinite(rank) || rank <= 0) continue;
    out.push({
      name,
      team: teamCode(p.player_team_id),
      position: (p.player_position_id ?? "").toUpperCase(),
      ecrRank: rank,
      posRank: (p.pos_rank ?? "").toUpperCase(),
      tier: Number(p.tier) || 0,
      delta: typeof p.player_ecr_delta === "number" ? p.player_ecr_delta : null,
      rankMin: num(p.rank_min),
      rankMax: num(p.rank_max),
      rankStd: num(p.rank_std),
    });
  }
  return out;
}

/**
 * Attach ECR to board entries by normalized name (+ team as a tiebreak).
 * Returns new entries; the count of matches is on `.matched`.
 */
export function attachEcr(
  entries: readonly BoardEntry[],
  ecr: readonly EcrEntry[],
): { entries: BoardEntry[]; matched: number } {
  const byNameTeam = new Map<string, EcrEntry>();
  const byName = new Map<string, EcrEntry>();
  for (const e of ecr) {
    const n = normalizeName(e.name);
    if (e.team) byNameTeam.set(`${n}|${e.team}`, e);
    if (!byName.has(n)) byName.set(n, e);
  }

  let matched = 0;
  const out = entries.map((entry) => {
    const n = normalizeName(entry.player.name);
    const hit = byNameTeam.get(`${n}|${teamCode(entry.player.team)}`) ?? byName.get(n);
    if (!hit) return entry;
    matched++;
    return {
      ...entry,
      ecrRank: hit.ecrRank,
      ecrPosRank: hit.posRank,
      ecrTier: hit.tier,
      ecrRankMin: hit.rankMin,
      ecrRankMax: hit.rankMax,
      ecrRankStd: hit.rankStd,
    };
  });
  return { entries: out, matched };
}

const ECR_TTL_MS = 8 * 60 * 60 * 1000;

export async function fetchEcr(
  cacheDir: string,
  scoring: LeagueSettings["scoring"],
  opts: { force?: boolean } = {},
): Promise<EcrEntry[]> {
  const page = PAGE_BY_SCORING[scoring];
  const url = `https://www.fantasypros.com/nfl/rankings/${page}`;
  const data = await cachedParsed<EcrEntry[]>(
    cacheDir,
    `fantasypros-ecr-${scoring}.json`,
    url,
    parseEcrHtml,
    { ttlMs: ECR_TTL_MS, force: opts.force },
  );
  return data ?? [];
}
