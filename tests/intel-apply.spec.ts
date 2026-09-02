import { test, expect } from "@playwright/test";
import {
  mergeIntel,
  impactMultiplier,
  adjustProjections,
  annotateBoard,
} from "../src/intel/apply.js";
import type { PartialIntel, IntelNote } from "../src/intel/types.js";
import type { Player } from "../src/lineup/types.js";
import type { BoardEntry } from "../src/draft/board.js";

const note = (text: string, asOf: string, horizon: IntelNote["horizon"] = "week"): IntelNote => ({
  text,
  source: "test",
  horizon,
  asOf,
});

test("mergeIntel sums impacts across providers, clamps to +-3, newest note first", () => {
  const a = new Map<string, PartialIntel>([
    ["p1", { notes: [note("DNP Wed", "2026-09-10T12:00:00Z")], weekImpact: -1, confidence: 0.75 }],
  ]);
  const b = new Map<string, PartialIntel>([
    ["p1", { notes: [note("ruled out", "2026-09-11T12:00:00Z")], weekImpact: -3, confidence: 0.5 }],
  ]);
  const merged = mergeIntel([a, b]);
  const p1 = merged.get("p1")!;
  expect(p1.weekImpact).toBe(-3); // -4 clamped
  expect(p1.confidence).toBe(0.75);
  expect(p1.notes[0]?.text).toBe("ruled out"); // newer
  expect(p1.asOf).toBe("2026-09-11T12:00:00Z");
});

test("impactMultiplier: mild near zero, collapses at Out-level", () => {
  expect(impactMultiplier(0)).toBe(1);
  expect(impactMultiplier(-0.7)).toBeCloseTo(0.895, 3);
  expect(impactMultiplier(-2.5)).toBe(0.15);
  expect(impactMultiplier(-3)).toBe(0.15);
  expect(impactMultiplier(1)).toBeCloseTo(1.15, 3);
  expect(impactMultiplier(3)).toBe(1.4); // clamped
});

function player(p: Partial<Player> & { id: string; projectedPoints: number }): Player {
  return {
    name: p.id,
    team: "KC",
    position: "WR",
    eligibleSlots: ["WR"],
    status: "OK",
    currentSlot: "WR",
    ...p,
  };
}

test("adjustProjections nudges only players with week intel, leaves others untouched", () => {
  const players = [
    player({ id: "hurt", projectedPoints: 20 }),
    player({ id: "fine", projectedPoints: 15 }),
  ];
  const intel = mergeIntel([
    new Map<string, PartialIntel>([
      ["hurt", { notes: [note("Questionable (hamstring)", "2026-09-10")], weekImpact: -0.7 }],
    ]),
  ]);
  const { players: out, adjustments } = adjustProjections(players, intel, { horizon: "week" });

  expect(out.find((p) => p.id === "fine")).toBe(players[1]); // identity preserved
  const hurt = out.find((p) => p.id === "hurt")!;
  expect(hurt.projectedPoints).toBeCloseTo(17.9, 1); // 20 * 0.895
  expect(adjustments).toHaveLength(1);
  expect(adjustments[0]).toMatchObject({ id: "hurt", from: 20, delta: -2.1 });
});

test("adjustProjections uses season impact when asked", () => {
  const players = [player({ id: "buzz", projectedPoints: 10 })];
  const intel = mergeIntel([
    new Map<string, PartialIntel>([
      ["buzz", { notes: [note("named starter", "2026-09-01", "season")], weekImpact: 0.5, seasonImpact: 2 }],
    ]),
  ]);
  const week = adjustProjections(players, intel, { horizon: "week" }).players[0]!.projectedPoints;
  const season = adjustProjections(players, intel, { horizon: "season" }).players[0]!.projectedPoints;
  expect(season).toBeGreaterThan(week);
});

test("adjustProjections records a note-only entry with zero delta", () => {
  const players = [player({ id: "n", projectedPoints: 12 })];
  const intel = mergeIntel([
    new Map<string, PartialIntel>([["n", { notes: [note("beat writer chatter", "2026-09-10")], weekImpact: 0 }]]),
  ]);
  const { players: out, adjustments } = adjustProjections(players, intel);
  expect(out[0]).toBe(players[0]); // unchanged
  expect(adjustments[0]).toMatchObject({ id: "n", delta: 0 });
  expect(adjustments[0]?.notes[0]?.text).toBe("beat writer chatter");
});

test("annotateBoard attaches intel without reordering", () => {
  const entries: BoardEntry[] = [
    { player: { id: "a", name: "A", position: "RB", team: "KC", bye: 6 }, xRank: 1, adp: 1, listRank: 1 },
    { player: { id: "b", name: "B", position: "WR", team: "SF", bye: 9 }, xRank: 2, adp: 2, listRank: 2 },
  ];
  const intel = mergeIntel([
    new Map<string, PartialIntel>([["b", { notes: [note("holdout", "2026-08-01", "season")], seasonImpact: -2 }]]),
  ]);
  const out = annotateBoard(entries, intel);
  expect(out.map((e) => e.player.id)).toEqual(["a", "b"]);
  expect(out[0]?.intel).toBeUndefined();
  expect(out[1]?.intel?.seasonImpact).toBe(-2);
});
