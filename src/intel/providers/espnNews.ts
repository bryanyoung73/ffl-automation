import { fetchPlayerNews } from "./espnNewsFeed.js";
import type { IntelContext, IntelNote, IntelProvider, PartialIntel } from "../types.js";

export { isPlayerBlurb, isActionable } from "./espnNewsFeed.js";

/**
 * ESPN player news with conservative keyword scoring. This is the non-LLM path
 * (`--llm` swaps in `newsDigest` instead). Items are pre-filtered by
 * `fetchPlayerNews` to name-led, actionable blurbs; scoring stays timid.
 */

interface Scored {
  week: number;
  season: number;
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
        const blurbs = await fetchPlayerNews(ctx, p);
        if (blurbs.length === 0) return;

        const notes: IntelNote[] = [];
        let week = 0;
        let season = 0;
        let scoredAny = false;
        for (const b of blurbs) {
          const s = scoreHeadline(`${b.headline} ${b.description}`);
          week += s.week;
          season += s.season;
          if (s.week !== 0 || s.season !== 0) scoredAny = true;
          notes.push({ text: b.headline, source: "espn-news", url: b.url, horizon: "both", asOf: b.asOf });
        }
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
