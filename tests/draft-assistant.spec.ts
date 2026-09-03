import { test, expect } from "@playwright/test";
import { computeAdvice } from "../src/draft/live/assistant.js";
import type { Board, BoardRow } from "../src/draft/board.js";
import type { LeagueSettings, Position } from "../src/draft/types.js";
import type { DraftPick, DraftState } from "../src/providers/types.js";

const settings: LeagueSettings = {
  teams: 4,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 3, // → 12 rounds, 48 picks
  draftType: "snake",
};
const ME = 99;

interface RowOpts {
  name?: string;
  adp?: number | null;
  vor?: number | null;
  vorRank?: number | null;
  ecrRank?: number | null;
  ecrTier?: number | null;
  ecrPosRank?: string | null;
  intelNote?: string;
}

function r(rank: number, position: Position, o: RowOpts = {}): BoardRow {
  return {
    rank,
    player: { id: o.name ?? `p${rank}`, name: o.name ?? `p${rank}`, position, team: "KC", bye: null },
    adp: o.adp ?? rank,
    xRank: null,
    listRank: rank,
    yahooExpertPos: null,
    yahooGap: null,
    ecrRank: o.ecrRank ?? null,
    ecrPosRank: o.ecrPosRank ?? null,
    ecrTier: o.ecrTier ?? null,
    tier: Math.ceil(rank / settings.teams),
    note: "",
    adpRank: rank,
    blendShift: 0,
    intelNote: o.intelNote ?? "",
    intelImpact: 0,
    adpChange: null,
    adpTrend: "",
    vor: o.vor ?? null,
    vorRank: o.vorRank ?? null,
    vorGap: null,
  };
}

function board(rows: BoardRow[]): Board {
  return {
    generatedAt: "2026-09-03T00:00:00.000Z",
    teams: settings.teams,
    threshold: 18,
    positionFilter: null,
    sourceLabel: "ESPN",
    expertLabel: "ECR",
    rows,
    disagreements: 0,
    verdict: "",
    blended: false,
    intelAsOf: "",
  };
}

function pick(overall: number, teamId: number, playerId: string, round = 1, pickInRound = overall): DraftPick {
  return { overall, round, pickInRound, teamId, playerId, keeper: false };
}
function st(picks: DraftPick[], extra: Partial<DraftState> = {}): DraftState {
  return { drafted: false, inProgress: true, picks, ...extra };
}

const baseRows = (): BoardRow[] => [
  r(1, "RB", { name: "rb1", vor: 95, vorRank: 1, ecrTier: 1, ecrPosRank: "RB1" }),
  r(2, "RB", { name: "rb2", vor: 88, vorRank: 2, ecrTier: 1, ecrPosRank: "RB2" }),
  r(3, "WR", { name: "wr1", vor: 82, vorRank: 3, ecrTier: 1, ecrPosRank: "WR1" }),
  r(4, "WR", { name: "wr2", vor: 78, vorRank: 4, ecrTier: 1, ecrPosRank: "WR2" }),
  r(7, "QB", { name: "qb1", vor: 70, vorRank: 8, ecrTier: 1, ecrPosRank: "QB1" }),
  r(9, "TE", { name: "te1", vor: 40, vorRank: 20, ecrTier: 1, ecrPosRank: "TE1" }),
  r(14, "RB", { name: "rb3", vor: 52, vorRank: 15, ecrTier: 2, ecrPosRank: "RB6" }),
  r(15, "RB", { name: "rb4", vor: 48, vorRank: 18, ecrTier: 2, ecrPosRank: "RB7" }),
  r(16, "WR", { name: "wr3", vor: 44, vorRank: 22, ecrTier: 2, ecrPosRank: "WR8" }),
  r(90, "DEF", { name: "def1", vor: 6, vorRank: 150 }),
  r(100, "K", { name: "k1", vor: 4, vorRank: 160 }),
];

test("fresh draft with a passed slot: pick label, turn math, ranked recs", () => {
  const advice = computeAdvice({ board: board(baseRows()), state: st([]), myTeamId: ME, mySlot: 2, settings });
  expect(advice.overall).toBe(1);
  expect(advice.label).toBe("1.01");
  expect(advice.onClock).toBe(false);
  expect(advice.slot).toBe(2);
  expect(advice.myNextOverall).toBe(2); // slot 2, round 1
  expect(advice.picksUntilNext).toBe(1);
  expect(advice.recommendations.length).toBe(6);
  expect(advice.recommendations[0]!.score).toBeGreaterThan(0);
  // empty roster → RB/WR need dominates; top pick is one of the studs
  expect(["RB", "WR"]).toContain(advice.recommendations[0]!.player.position);
});

test("slot is auto-detected from my round-1 pick, overriding the passed value", () => {
  const state = st([
    pick(1, 97, "x1"),
    pick(2, 98, "x2"),
    pick(3, ME, "rb1", 1, 3),
  ]);
  const advice = computeAdvice({ board: board(baseRows()), state, myTeamId: ME, mySlot: 1, settings });
  expect(advice.slot).toBe(3); // detected, not the passed 1
  expect(advice.myNextOverall).toBe(6); // snake: slot 3 in a 4-team, round 2
  expect(advice.picksUntilNext).toBe(2);
});

test("a drafted player never appears in recommendations", () => {
  const advice = computeAdvice({
    board: board(baseRows()),
    state: st([pick(1, 97, "rb1")]),
    myTeamId: ME,
    mySlot: 2,
    settings,
  });
  expect(advice.recommendations.some((rec) => rec.player.name === "rb1")).toBe(false);
});

test("reasons name the slot a pick fills", () => {
  // I already hold one RB → the next RB fills my 2nd RB slot
  const state = st([pick(5, ME, "rb2", 2, 3)]);
  const advice = computeAdvice({ board: board(baseRows()), state, myTeamId: ME, mySlot: 2, settings });
  const topRb = advice.recommendations.find((rec) => rec.player.position === "RB");
  expect(topRb).toBeTruthy();
  expect(topRb!.reasons[0]).toBe("fills your 2nd RB slot");
  // and my roster view carries the pick
  const rbSlot = advice.myRoster.find((s) => s.position === "RB");
  expect(rbSlot!.players).toEqual(["rb2"]);
  expect(advice.myRoster.map((s) => s.position)).toEqual(["QB", "RB", "WR", "TE", "K", "DEF"]);
});

test("a player likely gone by my next pick is flagged and bumped", () => {
  // 20 picks in by other teams; my next pick is overall 23
  const picks = Array.from({ length: 20 }, (_, i) => pick(i + 1, (i % 3) + 1, `ghost${i}`, Math.ceil((i + 1) / 4)));
  const rows = baseRows();
  rows.push(r(18, "RB", { name: "fADE", adp: 18, vor: 92, vorRank: 3, ecrTier: 1, ecrPosRank: "RB3" }));
  const advice = computeAdvice({ board: board(rows), state: st(picks), myTeamId: ME, mySlot: 2, settings });
  expect(advice.myNextOverall).toBe(23);
  const fade = advice.recommendations.find((rec) => rec.player.name === "fADE");
  expect(fade).toBeTruthy();
  expect(fade!.survival.bucket).toBe("gone");
  expect(fade!.reasons.some((x) => /won't last to 23/.test(x))).toBe(true);
});

test("a thinning tier surfaces as a cliff and a reason", () => {
  const advice = computeAdvice({ board: board(baseRows()), state: st([]), myTeamId: ME, mySlot: 2, settings });
  const rbCliff = advice.cliffs.find((c) => c.position === "RB");
  expect(rbCliff).toMatchObject({ remaining: 2, metric: "vor" });
  expect(rbCliff!.players).toEqual(["rb1", "rb2"]);
  const rb1 = advice.recommendations.find((rec) => rec.player.name === "rb1");
  expect(rb1!.reasons.some((x) => /tier/.test(x))).toBe(true);
});

test("no slot and none detected: turn math is null, recs still rank", () => {
  const advice = computeAdvice({
    board: board(baseRows()),
    state: st([pick(1, 97, "ghost0"), pick(2, 98, "ghost1")]),
    myTeamId: ME,
    mySlot: null,
    settings,
  });
  expect(advice.slot).toBeNull();
  expect(advice.myNextOverall).toBeNull();
  expect(advice.picksUntilNext).toBeNull();
  expect(advice.onClock).toBe(false);
  expect(advice.recommendations.length).toBeGreaterThan(0);
  expect(advice.recommendations.every((rec) => rec.survival.prob === null)).toBe(true);
});

test("a finished draft yields no recommendations", () => {
  const advice = computeAdvice({
    board: board(baseRows()),
    state: st([], { drafted: true }),
    myTeamId: ME,
    mySlot: 2,
    settings,
  });
  expect(advice.recommendations).toEqual([]);
  expect(advice.cliffs).toEqual([]);
  expect(advice.runs).toEqual([]);
  expect(advice.onClock).toBe(false);
});

test("top is configurable", () => {
  const advice = computeAdvice({ board: board(baseRows()), state: st([]), myTeamId: ME, mySlot: 2, settings, top: 3 });
  expect(advice.recommendations).toHaveLength(3);
});
