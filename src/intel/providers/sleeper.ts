import { cachedJson } from "../cache.js";
import { loadSleeperPlayers, type SleeperPlayer } from "../match.js";
import type { IntelContext, IntelNote, IntelProvider, PartialIntel } from "../types.js";

/**
 * Sleeper intel: injury designation, practice participation, and draft/waiver
 * buzz (trending adds). Injury/practice is a week signal; buzz leans season but
 * also nudges the week (a backup who's suddenly the starter).
 */

const TRENDING_URL =
  "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=200";
const TRENDING_TTL_MS = 60 * 60 * 1000;

interface TrendingRow {
  player_id: string;
  count: number;
}

/** Injury designation -> week impact. */
function injuryImpact(status: string): number {
  switch (status.toLowerCase()) {
    case "out":
    case "ir":
    case "pup":
    case "sus":
    case "suspended":
    case "nfi":
      return -3;
    case "doubtful":
      return -2.4;
    case "questionable":
      return -0.7;
    default:
      return 0;
  }
}

/** Practice participation -> additional week impact. */
function practiceImpact(raw: string): number {
  const p = raw.toLowerCase();
  if (p.includes("did not") || p === "dnp") return -1;
  if (p.includes("limited")) return -0.4;
  if (p.includes("full")) return 0.3;
  return 0;
}

function isoFrom(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : "";
}

function playerNotesAndImpact(sp: SleeperPlayer): PartialIntel {
  const notes: IntelNote[] = [];
  let weekImpact = 0;
  const asOf = isoFrom(sp.news_updated);

  const status = (sp.injury_status ?? "").trim();
  if (status) {
    weekImpact += injuryImpact(status);
    const bodyPart = sp.injury_body_part ? ` (${sp.injury_body_part})` : "";
    notes.push({
      text: `Injury: ${status}${bodyPart}`,
      source: "sleeper",
      horizon: "week",
      asOf,
    });
  }

  const practice = (sp.practice_participation ?? sp.practice_description ?? "").trim();
  if (practice) {
    weekImpact += practiceImpact(practice);
    notes.push({ text: `Practice: ${practice}`, source: "sleeper", horizon: "week", asOf });
  }

  const injNote = (sp.injury_notes ?? "").trim();
  if (injNote) {
    notes.push({ text: injNote, source: "sleeper", horizon: "week", asOf });
  }

  if (notes.length === 0) return {};
  return { notes, weekImpact, confidence: 0.75 };
}

/**
 * Depth-chart standing + age-curve risk from the Sleeper player record. Pure.
 * Season-horizon (a backup or an aging RB is a draft concern), though a backup
 * also won't help you this week.
 */
export function rolePartial(sp: SleeperPlayer): PartialIntel {
  const pos = (sp.position ?? "").toUpperCase();
  const notes: IntelNote[] = [];
  let seasonImpact = 0;
  let weekImpact = 0;
  const asOf = new Date().toISOString();

  const order = sp.depth_chart_order;
  if (typeof order === "number" && order >= 2 && ["QB", "RB", "WR", "TE"].includes(pos)) {
    if (pos === "QB") {
      seasonImpact -= 3;
      weekImpact -= 3;
      notes.push({ text: `Backup QB (depth chart ${order})`, source: "sleeper", horizon: "both", asOf });
    } else {
      const hit = order >= 3 ? 1.5 : 0.8;
      seasonImpact -= hit;
      weekImpact -= hit * 0.5;
      notes.push({
        text: `Behind the starter on the depth chart (${pos}${order})`,
        source: "sleeper",
        horizon: "both",
        asOf,
      });
    }
  }

  const age = sp.age;
  if (typeof age === "number") {
    let hit = 0;
    if (pos === "RB" && age >= 31) hit = 0.9;
    else if (pos === "RB" && age >= 29) hit = 0.4;
    else if ((pos === "WR" || pos === "TE") && age >= 34) hit = 0.6;
    else if ((pos === "WR" || pos === "TE") && age >= 32) hit = 0.3;
    else if (pos === "QB" && age >= 38) hit = 0.4;
    if (hit > 0) {
      seasonImpact -= hit;
      notes.push({ text: `Age ${age} — ${pos} age-curve risk`, source: "sleeper", horizon: "season", asOf });
    }
  }

  if (sp.years_exp === 0) {
    notes.push({ text: "Rookie — role still projecting", source: "sleeper", horizon: "season", asOf });
  }

  if (notes.length === 0) return {};
  return { notes, seasonImpact, weekImpact, confidence: 0.6 };
}

function trendingImpact(rank: number): number {
  if (rank < 10) return 0.8;
  if (rank < 25) return 0.5;
  if (rank < 50) return 0.3;
  return 0;
}

export const sleeperProvider: IntelProvider = {
  name: "sleeper",
  async collect(ctx: IntelContext): Promise<Map<string, PartialIntel>> {
    const out = new Map<string, PartialIntel>();

    const [sleeper, trending] = await Promise.all([
      loadSleeperPlayers(ctx.cacheDir),
      cachedJson<TrendingRow[]>(ctx.cacheDir, "sleeper-trending-add.json", TRENDING_URL, {
        ttlMs: TRENDING_TTL_MS,
      }),
    ]);

    const byId = new Map(sleeper.map((p) => [p.player_id, p]));
    const trendRank = new Map<string, number>();
    (trending ?? []).forEach((row, i) => trendRank.set(row.player_id, i));

    for (const p of ctx.players) {
      const sid = ctx.identity(p.id)?.sleeperId;
      if (!sid) continue;
      const sp = byId.get(sid);
      const parts: PartialIntel[] = [];

      if (sp) {
        const inj = playerNotesAndImpact(sp);
        if (inj.notes) parts.push(inj);
        const role = rolePartial(sp);
        if (role.notes) parts.push(role);
      }

      const rank = trendRank.get(sid);
      if (rank !== undefined) {
        const impact = trendingImpact(rank);
        if (impact > 0) {
          parts.push({
            notes: [
              {
                text: `Trending add on Sleeper (#${rank + 1} last 24h)`,
                source: "sleeper",
                horizon: "both",
                asOf: new Date().toISOString(),
              },
            ],
            weekImpact: impact * 0.5,
            seasonImpact: impact,
            confidence: 0.4,
          });
        }
      }

      if (parts.length === 0) continue;
      out.set(p.id, mergeParts(parts));
    }

    return out;
  },
};

function mergeParts(parts: PartialIntel[]): PartialIntel {
  return {
    notes: parts.flatMap((p) => p.notes ?? []),
    weekImpact: parts.reduce((s, p) => s + (p.weekImpact ?? 0), 0),
    seasonImpact: parts.reduce((s, p) => s + (p.seasonImpact ?? 0), 0),
    confidence: Math.max(0, ...parts.map((p) => p.confidence ?? 0)),
  };
}
