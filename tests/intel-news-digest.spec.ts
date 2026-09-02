import { test, expect } from "@playwright/test";
import { buildDigestInput, parseDigest } from "../src/intel/providers/newsDigest.js";
import type { NewsBlurb } from "../src/intel/providers/espnNewsFeed.js";
import type { IntelPlayerRef } from "../src/intel/types.js";

const player: IntelPlayerRef = { id: "3139477", name: "Patrick Mahomes", team: "KC", position: "QB" };
const blurbs: NewsBlurb[] = [
  { headline: "Mahomes (knee) on track to start Week 1", description: "Rapoport reports.", url: "http://x", asOf: "2026-09-02T00:00:00Z" },
  { headline: "Mahomes limited in Wednesday's practice", description: "", asOf: "2026-09-01T00:00:00Z" },
];

test("buildDigestInput includes the player, week, and every blurb", () => {
  const s = buildDigestInput(player, 1, blurbs);
  expect(s).toContain("Patrick Mahomes (QB, KC)");
  expect(s).toContain("Upcoming NFL week: 1");
  expect(s).toContain("Mahomes (knee) on track to start Week 1");
  expect(s).toContain("Mahomes limited in Wednesday's practice");
});

test("buildDigestInput says 'preseason' when week is 0", () => {
  expect(buildDigestInput(player, 0, blurbs)).toContain("Upcoming NFL week: preseason");
});

test("parseDigest clamps ranges and puts the summary first, blurbs after", () => {
  const partial = parseDigest(
    { week_impact: -5, season_impact: 0.5, confidence: 2, summary: "Knee, but expected to play." },
    blurbs,
  );
  expect(partial).not.toBeNull();
  expect(partial!.weekImpact).toBe(-3); // clamped from -5
  expect(partial!.seasonImpact).toBe(0.5);
  expect(partial!.confidence).toBe(1); // clamped from 2
  expect(partial!.notes?.[0]).toMatchObject({ text: "Knee, but expected to play.", source: "llm-digest" });
  expect(partial!.notes?.slice(1).map((n) => n.source)).toEqual(["espn-news", "espn-news"]);
});

test("parseDigest tolerates garbage and missing fields", () => {
  expect(parseDigest(null, blurbs)).toBeNull();
  expect(parseDigest("nope", blurbs)).toBeNull();
  const partial = parseDigest({ summary: "" }, blurbs);
  expect(partial!.weekImpact).toBe(0);
  expect(partial!.seasonImpact).toBe(0);
  expect(partial!.confidence).toBe(0.5);
  expect(partial!.notes?.[0]?.source).toBe("espn-news"); // no summary note
});
