import { test, expect } from "@playwright/test";
import { selectRecommendedSnapshot, gradeWeek, summarizeSeason, type WeekGrade } from "../src/tracking/grade.js";
import type { Snapshot } from "../src/tracking/store.js";
import type { Player } from "../src/lineup/types.js";

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
    livePoints: overrides.livePoints,
  };
}

function snapshot(week: number, fetchedAt: string, assignments: Snapshot["assignments"]): Snapshot {
  return { week, fetchedAt, assignments };
}

test("selectRecommendedSnapshot picks the latest one strictly before first lock", () => {
  const snaps = [
    snapshot(3, "2026-09-18T10:00Z", []),
    snapshot(3, "2026-09-19T09:00Z", []),
    snapshot(3, "2026-09-19T18:30Z", []), // after lock -- must not be picked
  ];
  const picked = selectRecommendedSnapshot(snaps, "2026-09-19T17:00Z");
  expect(picked?.fetchedAt).toBe("2026-09-19T09:00Z");
});

test("selectRecommendedSnapshot returns undefined when every snapshot came after the lock", () => {
  const snaps = [snapshot(3, "2026-09-19T18:00Z", [])];
  expect(selectRecommendedSnapshot(snaps, "2026-09-19T17:00Z")).toBeUndefined();
});

test("gradeWeek: perfect agreement scores zero delta and full agreement", () => {
  const rec = snapshot(1, "2026-09-10T00:00Z", [
    { slotCode: "RB", playerId: "a", playerName: "RB One" },
    { slotCode: "WR", playerId: "b", playerName: "WR One" },
  ]);
  const actual = [
    player({ id: "a", name: "RB One", currentSlot: "RB", livePoints: 20 }),
    player({ id: "b", name: "WR One", currentSlot: "WR", livePoints: 15 }),
    player({ id: "c", name: "Bench Guy", currentSlot: "BN", livePoints: 99 }), // must not count
  ];
  const grade = gradeWeek(rec, actual);
  expect(grade.recommendedTotal).toBe(35);
  expect(grade.actualTotal).toBe(35);
  expect(grade.delta).toBe(0);
  expect(grade.agreementCount).toBe(2);
  expect(grade.agreementRate).toBe(1);
  expect(grade.onlyRecommended).toEqual([]);
  expect(grade.onlyActual).toEqual([]);
});

test("gradeWeek: a real swap shows up in both onlyRecommended and onlyActual with real points", () => {
  const rec = snapshot(1, "2026-09-10T00:00Z", [
    { slotCode: "RB", playerId: "a", playerName: "RB One" },
    { slotCode: "W/R/T", playerId: "x", playerName: "Recommended Flex" },
  ]);
  const actual = [
    player({ id: "a", name: "RB One", currentSlot: "RB", livePoints: 20 }),
    player({ id: "x", name: "Recommended Flex", currentSlot: "BN", livePoints: 3 }), // benched instead
    player({ id: "y", name: "Actually Started", currentSlot: "W/R/T", livePoints: 25 }),
  ];
  const grade = gradeWeek(rec, actual);
  expect(grade.recommendedTotal).toBe(23); // 20 + 3 (x's real score, even though benched)
  expect(grade.actualTotal).toBe(45); // 20 + 25
  expect(grade.delta).toBe(22); // actual beat the recommendation
  expect(grade.agreementRate).toBe(0.5);
  expect(grade.onlyRecommended).toEqual([{ id: "x", name: "Recommended Flex", points: 3 }]);
  expect(grade.onlyActual).toEqual([{ id: "y", name: "Actually Started", points: 25 }]);
});

test("gradeWeek: a recommended player no longer on the roster at all scores 0, not a crash", () => {
  const rec = snapshot(1, "2026-09-10T00:00Z", [
    { slotCode: "RB", playerId: "dropped", playerName: "Since Dropped" },
  ]);
  const grade = gradeWeek(rec, []); // not on the roster returned by getWeekResult anymore
  expect(grade.recommendedTotal).toBe(0);
  expect(grade.onlyRecommended).toEqual([{ id: "dropped", name: "Since Dropped", points: 0 }]);
});

test("summarizeSeason aggregates across weeks and counts who won each week", () => {
  const weeks: WeekGrade[] = [
    { week: 1, recommendedTotal: 100, actualTotal: 90, delta: -10, agreementCount: 8, recommendedCount: 10, agreementRate: 0.8, onlyRecommended: [], onlyActual: [] },
    { week: 2, recommendedTotal: 100, actualTotal: 110, delta: 10, agreementCount: 10, recommendedCount: 10, agreementRate: 1, onlyRecommended: [], onlyActual: [] },
    { week: 3, recommendedTotal: 100, actualTotal: 100, delta: 0, agreementCount: 10, recommendedCount: 10, agreementRate: 1, onlyRecommended: [], onlyActual: [] },
  ];
  const summary = summarizeSeason(weeks);
  expect(summary.avgDelta).toBe(0);
  expect(summary.avgAgreementRate).toBe(0.93); // (0.8+1+1)/3, rounded to 2 decimals
  expect(summary.weeksRecommendationWasBetter).toBe(1);
  expect(summary.weeksActualWasBetter).toBe(1);
  expect(summary.weeksTied).toBe(1);
});

test("summarizeSeason with no weeks returns zeroed defaults, not NaN", () => {
  const summary = summarizeSeason([]);
  expect(summary).toEqual({
    weeks: [],
    avgAgreementRate: 0,
    avgDelta: 0,
    weeksRecommendationWasBetter: 0,
    weeksActualWasBetter: 0,
    weeksTied: 0,
  });
});
