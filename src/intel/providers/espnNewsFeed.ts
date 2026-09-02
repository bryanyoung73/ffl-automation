import { cachedJson } from "../cache.js";
import { normalizeName } from "../match.js";
import type { IntelContext, IntelPlayerRef } from "../types.js";

/**
 * Shared ESPN player-news fetch. Returns only the items that are genuinely about
 * the player's availability/usage — name-led beat-writer blurbs, not roundup or
 * opinion pieces. Both `espnNews` (keyword scoring) and `newsDigest` (LLM) read
 * from here.
 */

const NEWS_TTL_MS = 3 * 60 * 60 * 1000;
const PER_PLAYER = 4;

interface RawItem {
  headline?: string;
  description?: string;
  published?: string;
  lastModified?: string;
  links?: { web?: { href?: string } };
}

interface NewsResponse {
  news?: { feed?: RawItem[] };
  feed?: RawItem[];
}

export interface NewsBlurb {
  headline: string;
  description: string;
  url?: string;
  asOf: string;
}

/**
 * A blurb is "about this player" when the player's last name appears in the
 * first few words of the headline ("Gibbs had a strong day...", "Brown isn't in
 * uniform..."). Roundup titles put the player mid-sentence or not at all.
 */
export function isPlayerBlurb(headline: string, playerName: string): boolean {
  const parts = normalizeName(playerName).split(" ");
  const last = parts[parts.length - 1];
  if (!last || last.length < 3) return false;
  const head = normalizeName(headline).split(" ").slice(0, 4).join(" ");
  return head.includes(last);
}

/**
 * Keep a blurb only if it's about availability / usage — not a "bold
 * predictions" / "red flag" opinion piece that happens to lead with the name.
 */
export function isActionable(text: string): boolean {
  return /(practice|inactive|ruled|questionable|doubtful|injur|hamstring|ankle|knee|groin|shoulder|concussion|calf|hip|foot|back|snap|target|carr(?:y|ies)|first-team|starter|suspend|activat|placed on|return|limited|dnp|game-time|preseason|exhibition|did ?n.t play|did not play|will play|took part)/i.test(
    text,
  );
}

export function espnIdFor(ctx: IntelContext, p: IntelPlayerRef): string | undefined {
  return ctx.identity(p.id)?.espnId ?? (/^\d+$/.test(p.id) ? p.id : undefined);
}

/** Fetch and filter recent news for one player. */
export async function fetchPlayerNews(
  ctx: IntelContext,
  p: IntelPlayerRef,
): Promise<NewsBlurb[]> {
  const espnId = espnIdFor(ctx, p);
  if (!espnId) return [];

  const url =
    `https://site.api.espn.com/apis/fantasy/v3/games/ffl/news/players` +
    `?playerId=${espnId}&limit=${PER_PLAYER}`;
  const res = await cachedJson<NewsResponse>(ctx.cacheDir, `espn-news-${espnId}.json`, url, {
    ttlMs: NEWS_TTL_MS,
  });

  const out: NewsBlurb[] = [];
  for (const it of (res?.news?.feed ?? res?.feed ?? []).slice(0, PER_PLAYER)) {
    const headline = (it.headline ?? "").trim();
    const description = (it.description ?? "").trim();
    if (!headline || !isPlayerBlurb(headline, p.name) || !isActionable(`${headline} ${description}`)) {
      continue;
    }
    out.push({
      headline,
      description,
      url: it.links?.web?.href,
      asOf: it.published ?? it.lastModified ?? "",
    });
  }
  return out;
}
