import { test, expect } from "@playwright/test";
import { myRoster, rosterNeeds } from "../src/draft/live/needs.js";
import type { BoardEntry } from "../src/draft/board.js";
import type { LeagueSettings, Position } from "../src/draft/types.js";
import type { DraftState } from "../src/providers/types.js";

const settings: LeagueSettings = {
  teams: 10,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 6,
  draftType: "snake",
};

function e(id: string, position: Position): BoardEntry {
  return {
    player: { id, name: id, position, team: "KC", bye: null },
    xRank: null,
    adp: null,
    listRank: 1,
  };
}

const need = (needs: ReturnType<typeof rosterNeeds>, pos: Position) =>
  needs.find((n) => n.position === pos)!;

test("empty roster: open slots weight above 1, flex share flows to RB/WR/TE", () => {
  const needs = rosterNeeds([], settings);
  expect(needs.map((n) => n.position)).toEqual(["QB", "RB", "WR", "TE", "K", "DEF"]);

  expect(need(needs, "RB").weight).toBeCloseTo(3.4); // 1 + (2 open + 0.4 flex)
  expect(need(needs, "WR").weight).toBeCloseTo(3.4);
  expect(need(needs, "TE").weight).toBeCloseTo(2.2); // 1 + (1 + 0.2)
  expect(need(needs, "QB").weight).toBe(2); // 1 + 1, no flex
  expect(need(needs, "QB").flexShare).toBe(0);
});

test("K and DEF stay capped even with a starting slot open", () => {
  const needs = rosterNeeds([], settings);
  expect(need(needs, "K").startersLeft).toBe(1);
  expect(need(needs, "K").weight).toBe(0.9); // capped, not 2.0
  expect(need(needs, "DEF").weight).toBe(0.9);
});

test("a filled position drops to its depth floor and keeps counting bench", () => {
  const mine = [e("a", "RB"), e("b", "RB"), e("c", "RB")];
  const needs = rosterNeeds(mine, settings);
  const rb = need(needs, "RB");
  expect(rb.haveStarters).toBe(2);
  expect(rb.startersLeft).toBe(0);
  expect(rb.haveBench).toBe(1);
  expect(rb.weight).toBe(0.55); // DEPTH_FLOOR.RB — the 3rd RB ate the flex

  // that 3rd RB consumed the open FLEX, so WR's open-need drops from 3.4 -> 3.0
  expect(need(needs, "WR").weight).toBe(3);
});

test("a backup QB falls to the QB depth floor", () => {
  const needs = rosterNeeds([e("q", "QB")], settings);
  const qb = need(needs, "QB");
  expect(qb.startersLeft).toBe(0);
  expect(qb.weight).toBe(0.2);
  expect(qb.weight).toBeGreaterThan(0); // never exactly zero
});

test("myRoster resolves my picks against the board, ignoring other teams and off-board picks", () => {
  const board = [e("p1", "RB"), e("p2", "WR"), e("p3", "QB")];
  const state: DraftState = {
    drafted: false,
    inProgress: true,
    picks: [
      { overall: 5, round: 1, pickInRound: 5, teamId: 5, playerId: "p1", keeper: false },
      { overall: 6, round: 1, pickInRound: 6, teamId: 6, playerId: "p2", keeper: false },
      { overall: 16, round: 2, pickInRound: 5, teamId: 5, playerId: "p3", keeper: false },
      { overall: 17, round: 2, pickInRound: 6, teamId: 5, playerId: "p999", keeper: false },
    ],
  };
  const mine = myRoster(state, 5, board);
  expect(mine.map((x) => x.player.id)).toEqual(["p1", "p3"]);
});
