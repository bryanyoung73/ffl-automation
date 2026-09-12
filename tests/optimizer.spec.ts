import { test, expect } from "@playwright/test";
import { diffLineup, expandSlots, optimizeLineup } from "../src/lineup/optimizer.js";
import type { Player, PlayerStatus } from "../src/lineup/types.js";

let nextId = 1;
function player(overrides: Partial<Player> & Pick<Player, "position" | "projectedPoints">): Player {
  const position = overrides.position;
  return {
    id: overrides.id ?? `p${nextId++}`,
    name: overrides.name ?? `Player ${nextId}`,
    team: overrides.team ?? "FA",
    position,
    eligibleSlots: overrides.eligibleSlots ?? defaultEligible(position),
    projectedPoints: overrides.projectedPoints,
    status: (overrides.status ?? "OK") as PlayerStatus,
    currentSlot: overrides.currentSlot ?? "BN",
  };
}

function defaultEligible(position: string): string[] {
  if (["RB", "WR", "TE"].includes(position)) return [position, "W/R/T"];
  return [position];
}

test("expandSlots indexes repeated codes", () => {
  expect(expandSlots(["RB", "RB", "WR", "WR", "W/R/T"])).toEqual([
    { code: "RB", index: 0 },
    { code: "RB", index: 1 },
    { code: "WR", index: 0 },
    { code: "WR", index: 1 },
    { code: "W/R/T", index: 0 },
  ]);
});

test("starts the highest projection at each simple slot", () => {
  const players = [
    player({ name: "QB Low", position: "QB", projectedPoints: 12 }),
    player({ name: "QB High", position: "QB", projectedPoints: 22 }),
    player({ name: "TE Mid", position: "TE", projectedPoints: 9 }),
  ];
  const plan = optimizeLineup(players, ["QB", "TE"]);
  const bySlot = Object.fromEntries(
    plan.assignments.map((a) => [a.slot.code, a.player?.name]),
  );
  expect(bySlot.QB).toBe("QB High");
  expect(bySlot.TE).toBe("TE Mid");
  expect(plan.bench.map((p) => p.name)).toEqual(["QB Low"]);
  expect(plan.totalProjected).toBe(31);
});

test("benches an OUT player even if higher projected", () => {
  const players = [
    player({ name: "Star (OUT)", position: "WR", projectedPoints: 25, status: "O" }),
    player({ name: "Backup", position: "WR", projectedPoints: 8 }),
  ];
  const plan = optimizeLineup(players, ["WR"]);
  expect(plan.assignments[0]?.player?.name).toBe("Backup");
  expect(plan.bench.map((p) => p.name)).toContain("Star (OUT)");
});

test("BYE players are treated as un-startable", () => {
  const players = [
    player({ name: "On Bye", position: "RB", projectedPoints: 18, status: "BYE" }),
    player({ name: "Playing", position: "RB", projectedPoints: 11 }),
  ];
  const plan = optimizeLineup(players, ["RB"]);
  expect(plan.assignments[0]?.player?.name).toBe("Playing");
});

test("questionable players may still start", () => {
  const players = [
    player({ name: "Q Star", position: "RB", projectedPoints: 18, status: "Q" }),
    player({ name: "Healthy Scrub", position: "RB", projectedPoints: 6 }),
  ];
  const plan = optimizeLineup(players, ["RB"]);
  expect(plan.assignments[0]?.player?.name).toBe("Q Star");
});

test("fills flex with the best leftover RB/WR/TE", () => {
  const players = [
    player({ name: "RB1", position: "RB", projectedPoints: 20 }),
    player({ name: "RB2", position: "RB", projectedPoints: 15 }),
    player({ name: "WR1", position: "WR", projectedPoints: 18 }),
    player({ name: "WR2", position: "WR", projectedPoints: 17 }),
    player({ name: "TE1", position: "TE", projectedPoints: 5 }),
  ];
  // 1 RB, 1 WR, 1 flex -> RB1, WR1 start; flex should take WR2 (17) over RB2 (15).
  const plan = optimizeLineup(players, ["RB", "WR", "W/R/T"]);
  const flex = plan.assignments.find((a) => a.slot.code === "W/R/T");
  expect(flex?.player?.name).toBe("WR2");
  expect(plan.totalProjected).toBe(55);
});

test("global optimum beats naive slot-by-slot greedy", () => {
  // Greedy WR-first would take WR_BIG for the WR slot, leaving flex to a weak RB.
  // Optimal: WR_BIG in flex, WR_OK in WR slot, both RBs start -> higher total.
  const players = [
    player({ name: "RB_A", position: "RB", projectedPoints: 14 }),
    player({ name: "RB_B", position: "RB", projectedPoints: 13 }),
    player({ name: "RB_C", position: "RB", projectedPoints: 12 }),
    player({ name: "WR_BIG", position: "WR", projectedPoints: 30 }),
    player({ name: "WR_OK", position: "WR", projectedPoints: 10 }),
  ];
  const plan = optimizeLineup(players, ["RB", "RB", "WR", "W/R/T"]);
  const total = plan.assignments.reduce((s, a) => s + (a.player?.projectedPoints ?? 0), 0);
  expect(total).toBe(14 + 13 + 30 + 12); // RB_A, RB_B, WR_BIG(WR), RB_C(flex)...
});

test("short-handed roster leaves slots empty rather than crashing", () => {
  const players = [player({ name: "Lonely QB", position: "QB", projectedPoints: 15 })];
  const plan = optimizeLineup(players, ["QB", "RB", "WR"]);
  expect(plan.assignments.filter((a) => a.player === null)).toHaveLength(2);
  expect(plan.assignments[0]?.player?.name).toBe("Lonely QB");
});

test("pinned starter is respected even when suboptimal", () => {
  const players = [
    player({ id: "keep", name: "Sentimental", position: "RB", projectedPoints: 4, currentSlot: "RB" }),
    player({ id: "best", name: "Better", position: "RB", projectedPoints: 19 }),
  ];
  const plan = optimizeLineup(players, ["RB"], { pinnedPlayerIds: ["keep"] });
  expect(plan.assignments[0]?.player?.name).toBe("Sentimental");
});

test("a pinned player overrides the unstartable-status filter — a locked starter who got hurt mid-game stays put", () => {
  // Real scenario: his game already started (locked), he then went to "IR"
  // mid-game — status alone would normally bar him, but he can't be moved.
  const players = [
    player({ id: "locked", name: "Hurt Starter", position: "WR", projectedPoints: 14, status: "IR", currentSlot: "WR" }),
    player({ id: "bench", name: "Bench Guy", position: "WR", projectedPoints: 13, currentSlot: "BN" }),
  ];
  const plan = optimizeLineup(players, ["WR"], { pinnedPlayerIds: ["locked"] });
  expect(plan.assignments[0]?.player?.name).toBe("Hurt Starter");
  expect(plan.bench.map((p) => p.name)).toContain("Bench Guy");
});

test("a pinned bench player is frozen off the field, not promoted into a starting slot", () => {
  // Pinning only protects a player's *current* slot; a locked player who was
  // already on the bench must not get poached into a starting slot just
  // because he's now exempt from the status filter.
  const players = [
    player({ id: "lockedBench", name: "Locked Bench Guy", position: "WR", projectedPoints: 30, status: "IR", currentSlot: "BN" }),
    player({ id: "starter", name: "Normal Starter", position: "WR", projectedPoints: 10, currentSlot: "WR" }),
  ];
  const plan = optimizeLineup(players, ["WR"], { pinnedPlayerIds: ["lockedBench"] });
  expect(plan.assignments[0]?.player?.name).toBe("Normal Starter");
  expect(plan.bench.map((p) => p.name)).toContain("Locked Bench Guy");
});

test("diffLineup reports only real moves and the projection swing", () => {
  const players = [
    player({ id: "a", name: "Starter A", position: "RB", projectedPoints: 10, currentSlot: "RB" }),
    player({ id: "b", name: "Bench B", position: "RB", projectedPoints: 20, currentSlot: "BN" }),
  ];
  const plan = optimizeLineup(players, ["RB"]);
  const diff = diffLineup(players, plan);
  expect(diff.changes).toHaveLength(2);
  expect(diff.needsSubmit).toBe(true);
  expect(diff.currentProjected).toBe(10);
  expect(diff.proposedProjected).toBe(20);
  expect(diff.delta).toBe(10);
});

test("diffLineup is empty when the lineup is already optimal", () => {
  const players = [
    player({ id: "a", name: "Good", position: "QB", projectedPoints: 22, currentSlot: "QB" }),
    player({ id: "b", name: "Backup", position: "QB", projectedPoints: 10, currentSlot: "BN" }),
  ];
  const plan = optimizeLineup(players, ["QB"]);
  const diff = diffLineup(players, plan);
  expect(diff.changes).toHaveLength(0);
  expect(diff.needsSubmit).toBe(false);
});

test("diffLineup: pure slot-label reshuffle among the same starters needs no submit", () => {
  const players = [
    player({ id: "a", name: "Flex Guy", position: "WR", eligibleSlots: ["WR", "W/R/T"], projectedPoints: 12, currentSlot: "WR" }),
    player({ id: "b", name: "Other WR", position: "WR", eligibleSlots: ["WR", "W/R/T"], projectedPoints: 11, currentSlot: "W/R/T" }),
  ];
  const plan = optimizeLineup(players, ["WR", "W/R/T"]);
  const diff = diffLineup(players, plan);
  expect(diff.needsSubmit).toBe(false);
  expect(diff.delta).toBe(0);
});
