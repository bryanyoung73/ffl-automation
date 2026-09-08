import { test, expect } from "@playwright/test";
import { tierCliffs, positionRuns } from "../src/draft/live/context.js";
import type { BoardEntry, BoardRow } from "../src/draft/board.js";
import type { LeagueSettings, Position } from "../src/draft/types.js";
import type { DraftPick, DraftState } from "../src/providers/types.js";

const settings: LeagueSettings = {
  teams: 10,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 6,
  draftType: "snake",
};

function row(
  rank: number,
  position: Position,
  opts: { name?: string; ecrTier?: number | null; vor?: number | null; adp?: number | null } = {},
): BoardRow {
  return {
    rank,
    player: { id: `p${rank}`, name: opts.name ?? `Player ${rank}`, position, team: "KC", bye: null },
    adp: opts.adp ?? rank,
    xRank: null,
    listRank: rank,
    yahooExpertPos: null,
    yahooGap: null,
    ecrRank: null,
    ecrPosRank: null,
    ecrTier: opts.ecrTier ?? null,
    ecrRankMin: null,
    ecrRankMax: null,
    ecrRankStd: null,
    adpHigh: null,
    adpLow: null,
    adpStdev: null,
    tier: 1,
    note: "",
    adpRank: rank,
    blendShift: 0,
    intelNote: "",
    intelImpact: 0,
    adpChange: null,
    adpTrend: "",
    vor: opts.vor ?? null,
    vorRank: null,
    vorGap: null,
  };
}

test("tierCliffs flags a near-empty ECR tier with a real drop", () => {
  const rows = [
    row(5, "TE", { name: "Bowers", ecrTier: 1, vor: 60 }),
    row(9, "TE", { name: "Kittle", ecrTier: 1, vor: 55 }),
    row(24, "TE", { name: "McBride", ecrTier: 2, vor: 30 }),
    row(30, "TE", { name: "Loveland", ecrTier: 2, vor: 26 }),
  ];
  const [cliff] = tierCliffs(rows, settings);
  expect(cliff).toMatchObject({ position: "TE", remaining: 2, metric: "vor" });
  expect(cliff!.players).toEqual(["Bowers", "Kittle"]);
  expect(cliff!.drop).toBeCloseTo(25); // 55 - 30
});

test("tierCliffs stays quiet when the tier is still deep", () => {
  const rows = [1, 2, 3, 4, 5, 6].map((i) => row(i * 3, "WR", { ecrTier: 1, vor: 50 - i }));
  rows.push(row(40, "WR", { ecrTier: 2, vor: 20 }));
  expect(tierCliffs(rows, settings)).toEqual([]);
});

test("tierCliffs stays quiet when the drop is trivial", () => {
  const rows = [
    row(5, "RB", { ecrTier: 1, vor: 40 }),
    row(9, "RB", { ecrTier: 1, vor: 38 }),
    row(14, "RB", { ecrTier: 2, vor: 36 }), // only a 2-pt drop
  ];
  expect(tierCliffs(rows, settings)).toEqual([]);
});

test("tierCliffs falls back to a VOR gap when there are no ECR tiers", () => {
  const rows = [
    row(3, "RB", { name: "A", vor: 82 }),
    row(6, "RB", { name: "B", vor: 78 }),
    row(11, "RB", { name: "C", vor: 40 }), // 38-pt gap ends the tier
    row(15, "RB", { name: "D", vor: 35 }),
  ];
  const [cliff] = tierCliffs(rows, settings);
  expect(cliff).toMatchObject({ position: "RB", remaining: 2, metric: "vor" });
  expect(cliff!.drop).toBeCloseTo(38);
});

test("tierCliffs skips a position with no tiering signal at all", () => {
  const rows = [row(3, "WR"), row(6, "WR"), row(9, "WR")];
  expect(tierCliffs(rows, settings)).toEqual([]);
});

function pick(overall: number, teamId: number, playerId: string): DraftPick {
  return { overall, round: 1, pickInRound: overall, teamId, playerId, keeper: false };
}

function state(picks: DraftPick[]): DraftState {
  return { drafted: false, inProgress: true, picks };
}

test("positionRuns flags a position that dominated the recent window", () => {
  const board: BoardEntry[] = Array.from({ length: 12 }, (_, i) => ({
    player: { id: `p${i}`, name: `P${i}`, position: (i < 7 ? "RB" : "WR") as Position, team: "KC", bye: null },
    xRank: null,
    adp: i + 1,
    listRank: i + 1,
  }));
  const picks = board.map((e, i) => pick(i + 1, (i % 10) + 1, e.player.id));
  const [run] = positionRuns(state(picks), board, 12);
  expect(run).toMatchObject({ position: "RB", count: 7, window: 12 });
});

test("positionRuns is silent on a balanced board", () => {
  const board: BoardEntry[] = Array.from({ length: 12 }, (_, i) => ({
    player: { id: `p${i}`, name: `P${i}`, position: (["RB", "WR", "TE", "QB"][i % 4]) as Position, team: "KC", bye: null },
    xRank: null,
    adp: i + 1,
    listRank: i + 1,
  }));
  const picks = board.map((e, i) => pick(i + 1, (i % 10) + 1, e.player.id));
  expect(positionRuns(state(picks), board, 12)).toEqual([]);
});

test("positionRuns needs a minimum window before it will call a run", () => {
  const board: BoardEntry[] = Array.from({ length: 4 }, (_, i) => ({
    player: { id: `p${i}`, name: `P${i}`, position: "RB" as Position, team: "KC", bye: null },
    xRank: null,
    adp: i + 1,
    listRank: i + 1,
  }));
  const picks = board.map((e, i) => pick(i + 1, 1, e.player.id));
  expect(positionRuns(state(picks), board, 12)).toEqual([]); // only 4 picks
});

test("positionRuns ignores picks that aren't on the board", () => {
  const board: BoardEntry[] = [
    { player: { id: "known", name: "Known", position: "RB", team: "KC", bye: null }, xRank: null, adp: 1, listRank: 1 },
  ];
  const picks = Array.from({ length: 8 }, (_, i) => pick(i + 1, 1, i === 0 ? "known" : `ghost${i}`));
  expect(positionRuns(state(picks), board, 12)).toEqual([]); // 1 classifiable pick, no run
});
