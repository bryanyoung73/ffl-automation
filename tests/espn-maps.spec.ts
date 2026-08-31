import { test, expect } from "@playwright/test";
import {
  proTeamAbbr,
  slotCode,
  derivePosition,
  eligibleSlotCodes,
  injuryStatus,
  detectScoring,
  rankTypeForScoring,
  weeklyProjectedPoints,
  seasonProjectedPoints,
  draftBoardFilter,
} from "../src/providers/espn/maps.js";

test("proTeamAbbr maps ids and handles unknowns", () => {
  expect(proTeamAbbr(12)).toBe("KC");
  expect(proTeamAbbr(33)).toBe("BAL");
  expect(proTeamAbbr(0)).toBe("FA");
  expect(proTeamAbbr(999)).toBe("");
  expect(proTeamAbbr(null)).toBe("");
});

test("slotCode collapses flex variants to W/R/T and defaults unknown to BN", () => {
  expect(slotCode(0)).toBe("QB");
  expect(slotCode(2)).toBe("RB");
  expect(slotCode(4)).toBe("WR");
  expect(slotCode(6)).toBe("TE");
  expect(slotCode(16)).toBe("DEF");
  expect(slotCode(17)).toBe("K");
  expect(slotCode(20)).toBe("BN");
  expect(slotCode(21)).toBe("IR");
  for (const flex of [3, 5, 7, 23]) expect(slotCode(flex)).toBe("W/R/T");
  expect(slotCode(999)).toBe("BN");
});

test("derivePosition prefers eligible slots, falls back to defaultPositionId", () => {
  expect(derivePosition([2, 3, 23, 7, 20, 21], 2)).toBe("RB");
  expect(derivePosition([4, 23, 20, 21], 4)).toBe("WR");
  expect(derivePosition([0, 7, 20, 21], 1)).toBe("QB");
  expect(derivePosition([16, 20, 21], 16)).toBe("DEF");
  expect(derivePosition([10, 11, 23, 20, 21], 10)).toBe("LB"); // IDP
  // no usable slots -> use the id (ESPN scheme: 6 = TE, 17 = K)
  expect(derivePosition([20, 21], 6)).toBe("TE");
  expect(derivePosition(undefined, 17)).toBe("K");
});

test("eligibleSlotCodes drops bench/IR and dedupes", () => {
  expect(eligibleSlotCodes([2, 3, 23, 20, 21]).sort()).toEqual(["RB", "W/R/T"]);
  expect(eligibleSlotCodes([4, 20, 21])).toEqual(["WR"]);
  expect(eligibleSlotCodes([])).toEqual([]);
});

test("injuryStatus maps ESPN codes to PlayerStatus", () => {
  expect(injuryStatus("ACTIVE")).toBe("OK");
  expect(injuryStatus(undefined)).toBe("OK");
  expect(injuryStatus("QUESTIONABLE")).toBe("Q");
  expect(injuryStatus("OUT")).toBe("O");
  expect(injuryStatus("INJURY_RESERVE")).toBe("IR");
  expect(injuryStatus("SUSPENSION")).toBe("SUSP");
  expect(injuryStatus("something-new")).toBe("OK");
});

test("detectScoring reads the reception stat", () => {
  expect(detectScoring([{ statId: 53, points: 1 }])).toBe("ppr");
  expect(detectScoring([{ statId: 53, points: 0.5 }])).toBe("half-ppr");
  expect(detectScoring([{ statId: 53, points: 0 }])).toBe("standard");
  expect(detectScoring([{ statId: 3, points: 0.04 }])).toBe("standard");
  expect(detectScoring(undefined)).toBe("standard");
  expect(rankTypeForScoring("ppr")).toBe("PPR");
  expect(rankTypeForScoring("standard")).toBe("STANDARD");
});

test("projected-points extractors pick the right stat split", () => {
  const stats = [
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 19.9 },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 14.2 },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 15.1 },
    { statSourceId: 1, statSplitTypeId: 0, appliedTotal: 250.4 },
  ];
  expect(weeklyProjectedPoints(stats, 3)).toBe(14.2);
  expect(weeklyProjectedPoints(stats, 4)).toBe(15.1);
  expect(weeklyProjectedPoints(stats, 9)).toBe(0);
  expect(weeklyProjectedPoints(undefined, 3)).toBe(0);
  expect(seasonProjectedPoints(stats)).toBe(250.4);
});

test("draftBoardFilter is valid JSON with a limit and sort", () => {
  const parsed = JSON.parse(draftBoardFilter("PPR", 150));
  expect(parsed.players.limit).toBe(150);
  expect(parsed.players.sortDraftRanks.value).toBe("PPR");
});
