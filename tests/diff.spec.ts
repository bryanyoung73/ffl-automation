import { test, expect } from "@playwright/test";
import { findOverrides } from "../src/draft/diff.js";
import type { PlayerRef, PlayerSignals, Position, SignalName } from "../src/draft/types.js";

let seq = 1;
function ref(position: Position, name?: string): PlayerRef {
  return { id: `p${seq++}`, name: name ?? `p${seq}`, position, team: "FA", bye: 10 };
}
function entry(
  yahooRank: number,
  signals: Partial<Record<SignalName, number>>,
  position: Position = "RB",
  name?: string,
): PlayerSignals {
  return { player: ref(position, name), yahooRank, signals };
}

test("flags a player Yahoo ranks well below consensus as undervalued", () => {
  const players = [entry(30, { adp: 15, vor: 13 }, "WR", "Sleeper")];
  const [o] = findOverrides(players, { teams: 12, threshold: 10 });
  expect(o?.direction).toBe("undervalued");
  expect(o?.consensusRank).toBe(14);
  expect(o?.delta).toBe(16);
});

test("flags a player Yahoo ranks well above consensus as overvalued", () => {
  const players = [entry(8, { adp: 25, vor: 27 }, "RB", "Name Brand")];
  const [o] = findOverrides(players, { teams: 12, threshold: 10 });
  expect(o?.direction).toBe("overvalued");
  expect(o?.delta).toBe(-18);
});

test("ignores players within the threshold and same tier", () => {
  const players = [entry(6, { adp: 10, vor: 8 })]; // consensus 9, delta -3, both tier 1
  expect(findOverrides(players, { teams: 12, threshold: 10 })).toHaveLength(0);
});

test("tier crossing flags even when delta is under threshold", () => {
  // 12-team: yahoo rank 12 -> round 1, consensus ~19 -> round 2. delta -7 (< 10).
  const players = [entry(12, { adp: 19, vor: 19 })];
  const [o] = findOverrides(players, { teams: 12, threshold: 10 });
  expect(o?.crossesTier).toBe(true);
  expect(o?.direction).toBe("overvalued");
});

test("uses whatever signals are present", () => {
  const players = [entry(40, { adp: 20 })]; // only ADP
  const [o] = findOverrides(players, { teams: 12, threshold: 10 });
  expect(o?.consensusRank).toBe(20);
});

test("skips players with no signals at all", () => {
  const players = [entry(40, {})];
  expect(findOverrides(players, { teams: 12, threshold: 10 })).toHaveLength(0);
});

test("position filter restricts the analysis", () => {
  const players = [
    entry(40, { adp: 10 }, "RB", "Big RB gap"),
    entry(40, { adp: 10 }, "WR", "Big WR gap"),
  ];
  const rbOnly = findOverrides(players, { teams: 12, threshold: 10, position: "RB" });
  expect(rbOnly).toHaveLength(1);
  expect(rbOnly[0]?.player.position).toBe("RB");
});

test("results are sorted by magnitude of disagreement", () => {
  const players = [
    entry(20, { adp: 8 }, "RB", "Medium"), // delta 12
    entry(60, { adp: 20 }, "WR", "Huge"), // delta 40
    entry(15, { adp: 2 }, "TE", "Small-ish"), // delta 13
  ];
  const out = findOverrides(players, { teams: 12, threshold: 10 });
  expect(out.map((o) => o.player.name)).toEqual(["Huge", "Small-ish", "Medium"]);
});
