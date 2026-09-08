import { test, expect } from "@playwright/test";
import { computeVona } from "../src/draft/live/vona.js";
import type { BoardRow } from "../src/draft/board.js";
import type { Position } from "../src/draft/types.js";

function row(id: string, position: Position, vor: number | null, adp: number | null): BoardRow {
  return {
    rank: 1,
    player: { id, name: id.toUpperCase(), position, team: "KC", bye: null },
    adp,
    xRank: null,
    listRank: 1,
    yahooExpertPos: null,
    yahooGap: null,
    ecrRank: null,
    ecrPosRank: null,
    ecrTier: null,
    ecrRankMin: null,
    ecrRankMax: null,
    ecrRankStd: null,
    adpHigh: null,
    adpLow: null,
    adpStdev: null,
    tier: 1,
    note: "",
    adpRank: 1,
    blendShift: 0,
    intelNote: "",
    intelImpact: 0,
    adpChange: null,
    adpTrend: "",
    vor,
    vorRank: null,
    vorGap: null,
  };
}

test("gap is candidate VOR minus the best same-position player likely to last", () => {
  const cand = row("cand", "RB", 90, 3);
  const avail = [row("rbA", "RB", 70, 20), row("rbB", "RB", 55, 40), row("wr", "WR", 99, 4)];
  const v = computeVona(cand, avail, 15);
  expect(v).toEqual({ gap: 20, nextName: "RBA", nextAdp: 20 }); // 90 - 70; WR ignored
});

test("skips a same-position player who won't survive to my next pick", () => {
  const cand = row("cand", "RB", 90, 3);
  const avail = [
    row("rbEarly", "RB", 80, 5), // ADP 5, my pick 15 -> long gone
    row("rbLate", "RB", 55, 40), // ADP 40 -> safe
  ];
  const v = computeVona(cand, avail, 15);
  expect(v).toMatchObject({ gap: 35, nextName: "RBLATE" }); // 90 - 55
});

test("null when there is no known next pick", () => {
  expect(computeVona(row("c", "RB", 90, 3), [row("x", "RB", 50, 40)], null)).toBeNull();
});

test("null when the candidate has no VOR", () => {
  expect(computeVona(row("c", "RB", null, 3), [row("x", "RB", 50, 40)], 15)).toBeNull();
});

test("null when no same-position player is available", () => {
  const avail = [row("wr1", "WR", 80, 10), row("te1", "TE", 60, 12)];
  expect(computeVona(row("c", "RB", 90, 3), avail, 15)).toBeNull();
});

test("a no-ADP fallback player still counts as the next available", () => {
  const cand = row("cand", "RB", 90, 3);
  const avail = [row("rbNoAdp", "RB", 44, null)];
  const v = computeVona(cand, avail, 15);
  expect(v).toMatchObject({ gap: 46, nextName: "RBNOADP", nextAdp: null });
});
