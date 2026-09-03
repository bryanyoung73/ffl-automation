import { test, expect } from "@playwright/test";
import { mapDraftState } from "../src/providers/espn/EspnLeague.js";
import fixture from "./fixtures/espn-draft-detail.sample.json" with { type: "json" };

type Raw = Parameters<typeof mapDraftState>[0];
const raw = fixture as Raw;

test("mapDraftState reads the draft-room flags", () => {
  const s = mapDraftState(raw);
  expect(s.drafted).toBe(false);
  expect(s.inProgress).toBe(true);
});

test("mapDraftState maps every pick, in draft order", () => {
  const s = mapDraftState(raw);
  expect(s.picks).toHaveLength(15);
  expect(s.picks[0]).toEqual({
    overall: 1,
    round: 1,
    pickInRound: 1,
    teamId: 1,
    playerId: "4362628",
    keeper: false,
  });
  expect(s.picks.map((p) => p.overall)).toEqual(
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
});

test("mapDraftState keeps keeper picks and flags them", () => {
  const s = mapDraftState(raw);
  const keeper = s.picks.find((p) => p.keeper);
  expect(keeper?.overall).toBe(3);
  expect(keeper?.playerId).toBe("3116406");
  // still counts as a made pick — the player is off the board
  expect(s.picks.filter((p) => p.keeper)).toHaveLength(1);
});

test("mapDraftState follows the snake — round 2 reverses the team order", () => {
  const s = mapDraftState(raw);
  const round2 = s.picks.filter((p) => p.round === 2).map((p) => p.teamId);
  expect(round2).toEqual([10, 9, 8, 7, 6]);
});

test("mapDraftState sorts out-of-order picks and drops empty slots", () => {
  const s = mapDraftState({
    draftDetail: {
      drafted: false,
      inProgress: true,
      picks: [
        { overallPickNumber: 2, roundId: 1, roundPickNumber: 2, teamId: 2, playerId: 20 },
        { overallPickNumber: 1, roundId: 1, roundPickNumber: 1, teamId: 1, playerId: 10 },
        { overallPickNumber: 3, roundId: 1, roundPickNumber: 3, teamId: 3, playerId: 0 },
      ],
    },
  } as Raw);
  expect(s.picks.map((p) => p.playerId)).toEqual(["10", "20"]);
});

test("mapDraftState tolerates a missing draftDetail (draft not created yet)", () => {
  expect(mapDraftState({} as Raw)).toEqual({
    drafted: false,
    inProgress: false,
    picks: [],
  });
});

test("mapDraftState reports a finished draft", () => {
  const s = mapDraftState({
    draftDetail: { drafted: true, inProgress: false, picks: [] },
  } as Raw);
  expect(s.drafted).toBe(true);
  expect(s.inProgress).toBe(false);
});
