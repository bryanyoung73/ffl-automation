import { cachedJson } from "../cache.js";
import { teamCode } from "../match.js";
import type { IntelContext, IntelNote, IntelProvider, PartialIntel } from "../types.js";

/**
 * Vegas game context as a weekly signal (Phase 4). From ESPN's public NFL
 * scoreboard: each team's implied point total (O/U split by the spread) plus
 * light game-script and weather nuance. A WR on a team implied for 28 is in a
 * better spot than one on a team implied for 16; a big favorite grinds it out
 * on the ground; snow/wind hurts passing and kicking.
 *
 * Week-only — not run for the draft board. `parseScoreboard`, `impliedTotals`
 * and `vegasImpact` are pure and unit-tested.
 */

const SCOREBOARD_TTL_MS = 3 * 60 * 60 * 1000;
const LEAGUE_AVG_IMPLIED = 22;

/** homeImplied = ou/2 - spread/2 (spread is the home team's line). */
export function impliedTotals(overUnder: number, homeSpread: number): { home: number; away: number } {
  const half = overUnder / 2;
  return {
    home: round1(half - homeSpread / 2),
    away: round1(half + homeSpread / 2),
  };
}

export interface GameContext {
  team: string;
  opponent: string;
  home: boolean;
  /** This team's spread (negative = favored). */
  spread: number;
  impliedTotal: number;
  opponentImpliedTotal: number;
  overUnder: number;
  /** 0 = fine, 1 = rain/wind/cold, 2 = snow/high wind. */
  weatherBadness: number;
  weatherText: string;
}

interface RawScoreboard {
  events?: Array<{
    weather?: { displayValue?: string; temperature?: number };
    competitions?: Array<{
      competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
      odds?: Array<{ overUnder?: number; spread?: number }>;
    }>;
  }>;
}

export function weatherBadness(displayValue: string, temperature?: number): number {
  const t = displayValue.toLowerCase();
  let b = 0;
  if (/snow|blizzard|sleet|ice/.test(t)) b = 2;
  else if (/rain|showers|thunder|wind|fog/.test(t)) b = 1;
  if (typeof temperature === "number" && temperature <= 20) b += 1;
  return Math.min(2, b);
}

/** Pure: scoreboard JSON -> per-team game context. */
export function parseScoreboard(raw: RawScoreboard): Map<string, GameContext> {
  const out = new Map<string, GameContext>();
  for (const ev of raw.events ?? []) {
    const comp = ev.competitions?.[0];
    const odds = comp?.odds?.[0];
    if (!comp || !odds || typeof odds.overUnder !== "number" || typeof odds.spread !== "number") {
      continue;
    }
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    const homeAbbr = teamCode(home?.team?.abbreviation);
    const awayAbbr = teamCode(away?.team?.abbreviation);
    if (!homeAbbr || !awayAbbr) continue;

    const { home: homeImplied, away: awayImplied } = impliedTotals(odds.overUnder, odds.spread);
    const wText = ev.weather?.displayValue ?? "";
    const wBad = wText ? weatherBadness(wText, ev.weather?.temperature) : 0;

    out.set(homeAbbr, {
      team: homeAbbr,
      opponent: awayAbbr,
      home: true,
      spread: odds.spread,
      impliedTotal: homeImplied,
      opponentImpliedTotal: awayImplied,
      overUnder: odds.overUnder,
      weatherBadness: wBad,
      weatherText: wText,
    });
    out.set(awayAbbr, {
      team: awayAbbr,
      opponent: homeAbbr,
      home: false,
      spread: -odds.spread,
      impliedTotal: awayImplied,
      opponentImpliedTotal: homeImplied,
      overUnder: odds.overUnder,
      weatherBadness: wBad,
      weatherText: wText,
    });
  }
  return out;
}

const clampImpact = (n: number): number => Math.max(-2, Math.min(2, round1(n)));

/** Pure: a game context + position -> this week's Vegas bump. */
export function vegasImpact(input: {
  position: string;
  impliedTotal: number;
  opponentImpliedTotal: number;
  spread: number;
  weatherBadness: number;
}): number {
  const pos = input.position.toUpperCase();
  const bigFav = input.spread <= -7;
  const bigDog = input.spread >= 7;
  const w = input.weatherBadness;

  if (pos === "DEF" || pos === "DST" || pos === "D/ST") {
    // A defense wants a LOW opponent total; bad weather helps.
    return clampImpact((LEAGUE_AVG_IMPLIED - input.opponentImpliedTotal) * 0.13 + w * 0.15);
  }

  let x = (input.impliedTotal - LEAGUE_AVG_IMPLIED) * 0.13;

  if (bigFav) x += pos === "RB" ? 0.3 : -0.15;
  if (bigDog) x += pos === "RB" ? -0.3 : pos === "QB" ? 0.15 : 0.3;

  if (w > 0) {
    const passHit = w === 2 ? -0.5 : -0.25;
    if (pos === "K") x += w === 2 ? -0.8 : -0.4;
    else if (pos === "QB" || pos === "WR" || pos === "TE") x += passHit;
    else if (pos === "RB") x += 0.1; // bad weather leans run-heavy
  }

  return clampImpact(x);
}

function fmt1(n: number): string {
  return n.toFixed(1);
}

export const vegasProvider: IntelProvider = {
  name: "vegas",
  async collect(ctx: IntelContext): Promise<Map<string, PartialIntel>> {
    const out = new Map<string, PartialIntel>();

    const params = new URLSearchParams({ seasontype: "2", dates: String(ctx.season) });
    if (ctx.week > 0) params.set("week", String(ctx.week));
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?${params}`;
    const raw = await cachedJson<RawScoreboard>(
      ctx.cacheDir,
      `espn-scoreboard-${ctx.season}-wk${ctx.week}.json`,
      url,
      { ttlMs: SCOREBOARD_TTL_MS },
    );
    if (!raw) return out;

    const games = parseScoreboard(raw);
    if (games.size === 0) return out;

    for (const p of ctx.players) {
      const team = ctx.identity(p.id)?.team || teamCode(p.team);
      const g = team ? games.get(team) : undefined;
      if (!g) continue;

      const impact = vegasImpact({
        position: p.position,
        impliedTotal: g.impliedTotal,
        opponentImpliedTotal: g.opponentImpliedTotal,
        spread: g.spread,
        weatherBadness: g.weatherBadness,
      });

      const line = `${g.team} ${g.spread > 0 ? "+" : ""}${g.spread} ${g.home ? "vs" : "@"} ${g.opponent}`;
      const notes: IntelNote[] = [
        {
          text: `Implied total ${fmt1(g.impliedTotal)} (${line}, O/U ${g.overUnder})`,
          source: "vegas",
          horizon: "week",
          asOf: new Date().toISOString(),
        },
      ];
      if (g.weatherBadness > 0) {
        notes.push({
          text: `Weather: ${g.weatherText}`,
          source: "vegas",
          horizon: "week",
          asOf: new Date().toISOString(),
        });
      }

      out.set(p.id, { notes, weekImpact: impact, confidence: 0.55 });
    }

    return out;
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
