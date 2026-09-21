import { test, expect } from "@playwright/test";
import { buildSnapshot } from "../src/tracking/collect.js";
import type { LineupPlan, Player } from "../src/lineup/types.js";

function player(overrides: Partial<Player> & Pick<Player, "id" | "name">): Player {
  return {
    id: overrides.id,
    name: overrides.name,
    team: overrides.team ?? "FA",
    position: overrides.position ?? "RB",
    eligibleSlots: overrides.eligibleSlots ?? ["RB", "W/R/T"],
    projectedPoints: overrides.projectedPoints ?? 10,
    status: overrides.status ?? "OK",
    currentSlot: overrides.currentSlot ?? "RB",
  };
}

test("buildSnapshot records only filled slots, dropping empty ones", () => {
  const plan: LineupPlan = {
    assignments: [
      { slot: { code: "QB", index: 0 }, player: player({ id: "qb1", name: "Starter QB" }) },
      { slot: { code: "RB", index: 0 }, player: null }, // short-handed roster
    ],
    bench: [],
    totalProjected: 10,
  };
  const snap = buildSnapshot(3, plan, "2026-09-21T12:00:00Z");
  expect(snap).toEqual({
    week: 3,
    fetchedAt: "2026-09-21T12:00:00Z",
    assignments: [{ slotCode: "QB", playerId: "qb1", playerName: "Starter QB" }],
  });
});

test("buildSnapshot preserves assignment order and slot codes verbatim", () => {
  const plan: LineupPlan = {
    assignments: [
      { slot: { code: "RB", index: 0 }, player: player({ id: "a", name: "RB One" }) },
      { slot: { code: "RB", index: 1 }, player: player({ id: "b", name: "RB Two" }) },
      { slot: { code: "W/R/T", index: 0 }, player: player({ id: "c", name: "Flex Guy" }) },
    ],
    bench: [],
    totalProjected: 30,
  };
  const snap = buildSnapshot(1, plan);
  expect(snap.assignments.map((a) => a.slotCode)).toEqual(["RB", "RB", "W/R/T"]);
  expect(snap.assignments.map((a) => a.playerId)).toEqual(["a", "b", "c"]);
});
