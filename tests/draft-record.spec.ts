import { test, expect } from "@playwright/test";
import { buildMeta, buildEvent, buildFinal } from "../src/draft/live/record.js";
import { SURVIVAL_CONSTANTS } from "../src/draft/live/survival.js";
import type { Board, BoardRow } from "../src/draft/board.js";
import type { LeagueSettings, Position } from "../src/draft/types.js";
import type { DraftAdvice } from "../src/draft/live/types.js";
import type { DraftPick, DraftState } from "../src/providers/types.js";

const settings: LeagueSettings = {
  teams: 10,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 6, // → 15 rounds
  draftType: "snake",
};
const ME = 5;

function row(id: string, position: Position, o: { adp?: number; vor?: number; ecrRank?: number; ecrTier?: number } = {}): BoardRow {
  return {
    rank: 1,
    player: { id, name: id.toUpperCase(), position, team: "KC", bye: null },
    adp: o.adp ?? null,
    xRank: null,
    listRank: 1,
    yahooExpertPos: null,
    yahooGap: null,
    ecrRank: o.ecrRank ?? null,
    ecrPosRank: null,
    ecrTier: o.ecrTier ?? null,
    tier: 1,
    note: "",
    adpRank: 1,
    blendShift: 0,
    intelNote: "",
    intelImpact: 0,
    adpChange: null,
    adpTrend: "",
    vor: o.vor ?? null,
    vorRank: null,
    vorGap: null,
  };
}

const board: Board = {
  generatedAt: "t",
  teams: 10,
  threshold: 18,
  positionFilter: null,
  sourceLabel: "ESPN",
  expertLabel: "ECR",
  rows: [
    row("gibbs", "RB", { adp: 1.5, vor: 120, ecrRank: 1, ecrTier: 1 }),
    row("bijan", "RB", { adp: 2.4, vor: 110, ecrRank: 2, ecrTier: 1 }),
    row("chase", "WR", { adp: 3.1, vor: 105, ecrRank: 3 }),
    row("nabers", "WR", { adp: 6.0, vor: 95 }),
  ],
  disagreements: 0,
  verdict: "",
  blended: false,
  intelAsOf: "",
};

function pick(overall: number, teamId: number, playerId: string): DraftPick {
  return { overall, round: Math.ceil(overall / 10), pickInRound: ((overall - 1) % 10) + 1, teamId, playerId, keeper: false };
}
function st(picks: DraftPick[], drafted = false): DraftState {
  return { drafted, inProgress: !drafted, picks };
}

const advice: DraftAdvice = {
  onClock: false,
  overall: 3,
  label: "1.03",
  myNextOverall: 5,
  picksUntilNext: 2,
  pctComplete: 0.01,
  slot: 5,
  myRoster: [],
  recommendations: [
    {
      player: { id: "chase", name: "CHASE", position: "WR", team: "KC", bye: null },
      adp: 3.1,
      vor: 105,
      vorRank: 3,
      ecrPosRank: "WR1",
      needWeight: 3.4,
      survival: { prob: 0.12, bucket: "gone" },
      score: 361.2,
      reasons: ["fills your 1st WR slot", "won't last to 5 (ADP 3)"],
    },
  ],
  cliffs: [{ position: "RB", remaining: 2, players: ["GIBBS", "BIJAN"], drop: 20, metric: "vor" }],
  runs: [],
};

test("buildMeta captures league shape and the tuning constants in force", () => {
  const meta = buildMeta({ leagueId: "1144783883", teamId: ME, settings, board, slot: 7 });
  expect(meta).toMatchObject({
    kind: "meta",
    version: 1,
    leagueId: "1144783883",
    teamId: 5,
    teams: 10,
    scoring: "ppr",
    rounds: 15, // 9 starters + 6 bench
    boardSize: 4,
    ecrMatched: 3,
    slot: 7,
  });
  expect(meta.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 });
  expect(meta.constants.survival).toEqual(SURVIVAL_CONSTANTS);
  expect(meta.constants.cliff.vorTierGap).toBe(12);
});

test("buildEvent turns new picks into landed rows with adpError and the mine flag", () => {
  const state = st([pick(1, 1, "gibbs"), pick(2, 2, "bijan")]);
  const ev = buildEvent(0, state, board, advice, ME);
  expect(ev.pickCount).toBe(2);
  expect(ev.landed).toHaveLength(2);
  expect(ev.landed[0]).toMatchObject({
    overall: 1,
    playerId: "gibbs",
    name: "GIBBS",
    position: "RB",
    adp: 1.5,
    adpError: -0.5, // 1 - 1.5
    mine: false,
  });
});

test("buildEvent only emits picks made since prevPickCount", () => {
  const state = st([
    pick(1, 1, "gibbs"),
    pick(2, 2, "bijan"),
    pick(3, 3, "chase"),
    pick(4, 4, "nabers"),
  ]);
  const ev = buildEvent(2, state, board, advice, ME);
  expect(ev.landed.map((l) => l.playerId)).toEqual(["chase", "nabers"]);
});

test("a pick deeper than the board still records, with null fields", () => {
  const state = st([pick(1, 1, "deep-sleeper")]);
  const ev = buildEvent(0, state, board, advice, ME);
  expect(ev.landed[0]).toMatchObject({
    playerId: "deep-sleeper",
    name: "deep-sleeper", // falls back to the id
    position: null,
    adp: null,
    adpError: null,
  });
});

test("buildEvent trims the advice to a snapshot", () => {
  const ev = buildEvent(0, st([pick(1, 1, "gibbs")]), board, advice, ME);
  const rec = ev.advice.recommendations[0]!;
  expect(rec).toEqual({
    playerId: "chase",
    name: "CHASE",
    position: "WR",
    score: 361.2,
    adp: 3.1,
    survivalProb: 0.12,
    survivalBucket: "gone",
  });
  expect(ev.advice.cliffs).toHaveLength(1);
  expect("reasons" in rec).toBe(false);
});

test("buildFinal lists only my picks", () => {
  const state = st(
    [pick(1, 1, "gibbs"), pick(5, ME, "chase"), pick(16, ME, "nabers"), pick(6, 6, "bijan")],
    true,
  );
  const fin = buildFinal(state, board, ME);
  expect(fin.kind).toBe("final");
  expect(fin.totalPicks).toBe(4);
  expect(fin.myRoster).toEqual([
    { overall: 5, playerId: "chase", name: "CHASE", position: "WR" },
    { overall: 16, playerId: "nabers", name: "NABERS", position: "WR" },
  ]);
});
