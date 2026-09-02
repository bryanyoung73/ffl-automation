import { cachedJson } from "../cache.js";
import { normalizeName } from "../match.js";
import type { IntelContext, IntelNote, IntelProvider, PartialIntel } from "../types.js";

/**
 * ESPN player news — the most recent blurbs for each player. Phase 1 keeps this
 * light: every item becomes a readable note, but impact scoring only fires on
 * player-specific beat-writer blurbs (headline leads with the player's name),
 * never on roundup articles ("Do Draft list", "sleepers & breakouts") that
 * merely mention them. Real extraction is Phase 3 (LLM digest).
 */

const NEWS_TTL_MS = 3 * 60 * 60 * 1000;
const PER_PLAYER = 4;

interface NewsItem {
  headline?: string;
  description?: string;
  published?: string;
  lastModified?: string;
  links?: { web?: { href?: string } };
}

/** ESPN wraps the list under `news.feed`. */
interface NewsResponse {
  news?: { feed?: NewsItem[] };
  feed?: NewsItem[];
}

interface Scored {
  week: number;
  season: number;
}

/**
 * A blurb is "about this player" when the player's last name appears in the
 * first few words of the headline (beat-writer style: "Gibbs had a strong
 * day...", "Brown isn't in uniform..."). Roundup titles put the player mid-
 * sentence or not at all.
 */
export function isPlayerBlurb(headline: string, playerName: string): boolean {
  const parts = normalizeName(playerName).split(" ");
  const last = parts[parts.length - 1];
  if (!last || last.length < 3) return false;
  const head = normalizeName(headline).split(" ").slice(0, 4).join(" ");
  return head.includes(last);
}

/** Conservative keyword scoring — only applied to player-specific blurbs. */
export function scoreHeadline(text: string): Scored {
  const t = text.toLowerCase();
  if (/(ruled out|won't play|will not play|inactive|placed on ir|out for the season|to miss)/.test(t)) {
    return { week: -3, season: -1 };
  }
  if (/(doubtful|game-time decision|did not (?:practice|participate)|dnp|won't practice)/.test(t)) {
    return { week: -1.5, season: 0 };
  }
  if (/(questionable|limited (?:in )?practice|dealing with|banged up|tweaked)/.test(t)) {
    return { week: -0.7, season: 0 };
  }
  if (/(on track (?:to|for)|expected to (?:play|suit up)|will play|cleared|activated|returned to practice|full participant|good to go|no injury designation)/.test(t)) {
    return { week: 0.7, season: 0.2 };
  }
  if (/(named (?:the )?starter|took first-team reps|will start|takes over|lead back|bell cow|every-?down role)/.test(t)) {
    return { week: 0.4, season: 1 };
  }
  return { week: 0, season: 0 };
}

export const espnNewsProvider: IntelProvider = {
  name: "espn-news",
  async collect(ctx: IntelContext): Promise<Map<string, PartialIntel>> {
    const out = new Map<string, PartialIntel>();

    await Promise.all(
      ctx.players.map(async (p) => {
        const espnId = ctx.identity(p.id)?.espnId ?? (/^\d+$/.test(p.id) ? p.id : undefined);
        if (!espnId) return;

        const url =
          `https://site.api.espn.com/apis/fantasy/v3/games/ffl/news/players` +
          `?playerId=${espnId}&limit=${PER_PLAYER}`;
        const res = await cachedJson<NewsResponse>(
          ctx.cacheDir,
          `espn-news-${espnId}.json`,
          url,
          { ttlMs: NEWS_TTL_MS },
        );
        const items = (res?.news?.feed ?? res?.feed ?? []).slice(0, PER_PLAYER);
        if (items.length === 0) return;

        const notes: IntelNote[] = [];
        let week = 0;
        let season = 0;
        let scoredAny = false;
        for (const it of items) {
          const headline = (it.headline ?? "").trim();
          if (!headline) continue;
          if (isPlayerBlurb(headline, p.name)) {
            const s = scoreHeadline(`${headline} ${it.description ?? ""}`);
            week += s.week;
            season += s.season;
            if (s.week !== 0 || s.season !== 0) scoredAny = true;
          }
          notes.push({
            text: headline,
            source: "espn-news",
            url: it.links?.web?.href,
            horizon: "both",
            asOf: it.published ?? it.lastModified ?? "",
          });
        }
        if (notes.length === 0) return;
        out.set(p.id, {
          notes,
          weekImpact: week,
          seasonImpact: season,
          confidence: scoredAny ? 0.5 : 0.2,
        });
      }),
    );

    return out;
  },
};
