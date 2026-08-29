import { test, expect } from "@playwright/test";
import { computeVor } from "../src/draft/vor.js";
import type { LeagueSettings, PlayerProjection, Position } from "../src/draft/types.js";

let seq = 1;
function proj(position: Position, points: number, name?: string): PlayerProjection {
  const id = `p${seq++}`;
  return { id, name: name ?? id, position, team: "FA", bye: null, projectedPoints: points };
}

const settings: LeagueSettings = {
  teams: 2,
  scoring: "half-ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 5,
  draftType: "snake",
};

test("VOR subtracts the position replacement level", () => {
  // 2 teams, 1 QB each -> 2 QB starters. Replacement QB = 3rd best QB.
  const players = [
    proj("QB", 300, "QB1"),
    proj("QB", 280, "QB2"),
    proj("QB", 250, "QB3"), // replacement
    proj("QB", 200, "QB4"),
  ];
  const vor = computeVor(players, settings);
  expect(vor.get(players[0]!.id)?.vor).toBe(50); // 300 - 250
  expect(vor.get(players[1]!.id)?.vor).toBe(30); // 280 - 250
  expect(vor.get(players[2]!.id)?.vor).toBe(0); // replacement itself
});

test("FLEX pulls the replacement line deeper for RB/WR/TE", () => {
  // 2 teams: RB starters = 2*2 = 4 dedicated. Plus 1 FLEX each = 2 more from best
  // remaining RB/WR/TE. With only RBs present, 2 of those flex slots go to RBs,
  // so 6 RBs "start" and replacement RB = 7th best.
  const rbs = [220, 210, 200, 190, 180, 170, 160, 150].map((pts, i) =>
    proj("RB", pts, `RB${i + 1}`),
  );
  const vor = computeVor(rbs, settings);
  // replacement = RB7 = 160
  expect(vor.get(rbs[0]!.id)?.vor).toBe(60); // 220 - 160
  expect(vor.get(rbs[6]!.id)?.vor).toBe(0);
});

test("scarce position (fewer players than demand) uses 0 replacement", () => {
  const players = [proj("K", 140, "K1")]; // demand is 2, only 1 exists
  const vor = computeVor(players, settings);
  expect(vor.get(players[0]!.id)?.vor).toBe(140);
});

test("vorRank orders all players by VOR across positions", () => {
  const players = [
    proj("QB", 400, "Elite QB"),
    proj("QB", 100, "Bad QB"),
    proj("RB", 250, "RB1"),
    proj("RB", 240, "RB2"),
    proj("RB", 120, "RB3"),
    proj("WR", 260, "WR1"),
    proj("WR", 250, "WR2"),
    proj("WR", 130, "WR3"),
  ];
  const vor = computeVor(players, settings);
  const ranked = [...vor.entries()].sort((a, b) => a[1].vorRank - b[1].vorRank);
  expect(ranked[0]?.[1].vorRank).toBe(1);
  // ranks are a dense 1..n permutation
  expect(ranked.map((r) => r[1].vorRank)).toEqual(players.map((_, i) => i + 1));
});
