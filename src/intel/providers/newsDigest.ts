import { createHash } from "node:crypto";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { readCache, writeCache } from "../cache.js";
import { fetchPlayerNews, espnIdFor, type NewsBlurb } from "./espnNewsFeed.js";
import type {
  IntelContext,
  IntelNote,
  IntelPlayerRef,
  IntelProvider,
  PartialIntel,
} from "../types.js";

/**
 * LLM digest of beat-writer blurbs (Phase 3). Enabled with `--llm` /
 * `INTEL_LLM=1`; replaces the `espnNews` keyword path. For each player it sends
 * the recent actionable blurbs to Claude and gets back one structured
 * assessment — week/season impact, a confidence, and a one-line summary that
 * becomes the player's headline note. Per-player results are cached on disk
 * keyed by a hash of the blurb text, so a `--refresh` that doesn't change the
 * news costs nothing.
 */

const DIGEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Gentle by default — new API accounts have low rate limits. Override with
 *  INTEL_LLM_CONCURRENCY. */
const CONCURRENCY = Math.max(1, Number(process.env.INTEL_LLM_CONCURRENCY) || 2);
/** Per-call ceiling so a hung/queued request fails fast instead of at ~10 min. */
const CALL_TIMEOUT_MS = 45_000;

const SYSTEM = [
  "You are a fantasy football analyst.",
  "Given the most recent news blurbs about ONE NFL player, produce a single",
  "structured read of how the news changes his fantasy value.",
  "Base the assessment ONLY on the blurbs provided. If they say nothing that",
  "moves the needle, return zeros with low confidence.",
  "week_impact / season_impact are on a -3..+3 scale: -3 = do not start / hard",
  "fade, 0 = no change, +3 = clear buy / must-start bump.",
  "summary is ONE sentence naming the single most decision-relevant fact.",
].join(" ");

interface DigestTool {
  week_impact: number;
  season_impact: number;
  confidence: number;
  summary: string;
}

const TOOL: Anthropic.Tool = {
  name: "record_intel",
  description: "Record the structured fantasy-impact read of the player news.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["week_impact", "season_impact", "confidence", "summary"],
    properties: {
      week_impact: { type: "number", minimum: -3, maximum: 3 },
      season_impact: { type: "number", minimum: -3, maximum: 3 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 240 },
    },
  },
};

/** Pure: the user-turn text sent to the model. */
export function buildDigestInput(
  player: IntelPlayerRef,
  week: number,
  blurbs: readonly NewsBlurb[],
): string {
  const lines = blurbs.map(
    (b, i) => `${i + 1}. (${b.asOf || "no date"}) ${b.headline}${b.description ? ` — ${b.description}` : ""}`,
  );
  return [
    `Player: ${player.name} (${player.position}, ${player.team})`,
    `Upcoming NFL week: ${week || "preseason"}`,
    "",
    "Recent blurbs:",
    ...lines,
  ].join("\n");
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const x = typeof n === "number" && Number.isFinite(n) ? n : dflt;
  return Math.max(lo, Math.min(hi, x));
};

/** Pure: validate/normalize the tool payload into a PartialIntel. */
export function parseDigest(raw: unknown, blurbs: readonly NewsBlurb[]): PartialIntel | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<DigestTool>;
  const summary = typeof d.summary === "string" ? d.summary.trim() : "";
  const notes: IntelNote[] = [];
  if (summary) {
    notes.push({ text: summary, source: "llm-digest", horizon: "both", asOf: new Date().toISOString() });
  }
  for (const b of blurbs) {
    notes.push({ text: b.headline, source: "espn-news", url: b.url, horizon: "both", asOf: b.asOf });
  }
  return {
    notes,
    weekImpact: clamp(d.week_impact, -3, 3, 0),
    seasonImpact: clamp(d.season_impact, -3, 3, 0),
    confidence: clamp(d.confidence, 0, 1, 0.5),
  };
}

function blurbHash(blurbs: readonly NewsBlurb[]): string {
  const h = createHash("sha1");
  for (const b of blurbs) h.update(`${b.headline} ${b.description} `);
  return h.digest("hex").slice(0, 16);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export const newsDigestProvider: IntelProvider = {
  name: "news-digest",
  async collect(ctx: IntelContext): Promise<Map<string, PartialIntel>> {
    const out = new Map<string, PartialIntel>();
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.warn("intel: news-digest skipped — set ANTHROPIC_API_KEY to enable the LLM digest");
      return out;
    }

    const client = new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: 3 });
    const digestDir = resolve(ctx.cacheDir, "llm-digest");
    const failures: string[] = [];
    let calls = 0;

    await mapLimit(ctx.players, CONCURRENCY, async (p) => {
      const blurbs = await fetchPlayerNews(ctx, p);
      if (blurbs.length === 0) return;

      const key = `${espnIdFor(ctx, p) ?? p.id}-${blurbHash(blurbs)}.json`;
      const cached = readCache<PartialIntel>(digestDir, key, DIGEST_TTL_MS);
      if (cached) {
        out.set(p.id, cached);
        return;
      }

      calls++;
      try {
        const res = await client.messages.create({
          model: ctx.llmModel,
          max_tokens: 2048,
          system: SYSTEM,
          tools: [TOOL],
          tool_choice: { type: "tool", name: "record_intel" },
          messages: [{ role: "user", content: buildDigestInput(p, ctx.week, blurbs) }],
        });
        const toolUse = res.content.find((b) => b.type === "tool_use");
        const partial = parseDigest(toolUse && "input" in toolUse ? toolUse.input : null, blurbs);
        if (partial) {
          writeCache(digestDir, key, partial);
          out.set(p.id, partial);
        }
      } catch (err) {
        failures.push(`${p.name}: ${(err as Error).message}`);
      }
    });

    if (failures.length) {
      const sample = failures[0]!.split(": ").slice(1).join(": ");
      console.warn(
        `intel: news-digest — ${failures.length}/${calls} calls failed (${sample}). ` +
          `Successful reads are cached; re-run to fill the rest. If it's rate ` +
          `limits, lower INTEL_LLM_CONCURRENCY or add credits at console.anthropic.com.`,
      );
    }

    return out;
  },
};
