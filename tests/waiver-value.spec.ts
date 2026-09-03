import { test, expect } from "@playwright/test";
import { rosProjection, positionalReplacement, valuePlayers, type ValueInput } from "../src/waivers/value.js";
import type { LeagueSettings } from "../src/draft/types.js";
import type { PlayerIntel } from "../src/intel/types.js";

const settings: LeagueSettings = {
  teams: 2,
  scoring: "ppr",
  starters: { QB: 1, RB: 1, WR: 1, "W/R/T": 1 },
  benchSize: 4,
  draftType: "snake",
};

const fa = (id: string, position: string, weekProj: number, seasonProj: number, actualSoFar = 0, pctChange = 0): ValueInput => ({
  id,
  position,
  weekProj,
  seasonProj,
  actualSoFar,
  pctChange,
});

test("rosProjection is season projection minus points banked, floored at 0", () => {
  expect(rosProjection(300, 120)).toBe(180);
  expect(rosProjection(300, 0)).toBe(300);
  expect(rosProjection(50, 90)).toBe(0);
});

test("positionalReplacement is the player past the last league-wide starter", () => {
  // 2 teams, RB competes for 1 dedicated + 1 flex = 2 slots -> 4 league starters.
  const players = ["a", "b", "c", "d", "e", "f"].map((id, i) => fa(id, "RB", 10, 200 - i * 20));
  const repl = positionalReplacement(players, settings);
  // ros: 200,180,160,140,120,100 -> index 2*2 = 4 -> 120
  expect(repl.get("RB")).toBe(120);
});

test("valuePlayers blends ROS and week by rosWeight, adds buzz", () => {
  const players = [
    fa("rb1", "RB", 15, 260, 0, 0.2), // strong riser
    fa("rb2", "RB", 12, 240),
    fa("rb3", "RB", 8, 150),
    fa("rb4", "RB", 6, 120),
    fa("rb5", "RB", 4, 90),
  ];
  const ros = valuePlayers(players, { settings, rosWeight: 1 });
  const now = valuePlayers(players, { settings, rosWeight: 0 });

  // rosWeight 1 => blended == rosVal + buzz
  expect(ros.get("rb1")!.blended).toBeCloseTo(ros.get("rb1")!.rosVal + ros.get("rb1")!.buzz, 1);
  // rosWeight 0 => blended == weekVal + buzz
  expect(now.get("rb1")!.blended).toBeCloseTo(now.get("rb1")!.weekVal + now.get("rb1")!.buzz, 1);
  // the riser's buzz is capped at 3
  expect(ros.get("rb1")!.buzz).toBe(3);
});

test("intel nudges ROS by seasonImpact and this-week by weekImpact", () => {
  const players = [fa("x", "WR", 10, 170), fa("y", "WR", 10, 170), fa("z", "WR", 10, 60)];
  const intelById = new Map<string, PlayerIntel>([
    ["x", { playerKey: "x", notes: [], seasonImpact: 2, weekImpact: -2, confidence: 0.6, asOf: "" }],
  ]);
  const base = valuePlayers(players, { settings, rosWeight: 0.7 }).get("x")!;
  const withIntel = valuePlayers(players, { settings, rosWeight: 0.7, intelById }).get("x")!;
  expect(withIntel.rosVal).toBeGreaterThan(base.rosVal); // +2 season
  expect(withIntel.weekVal).toBeLessThan(base.weekVal); // -2 week
});
