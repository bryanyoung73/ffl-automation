import { test, expect } from "@playwright/test";
import {
  detectScoring,
  mapSettings,
  mapSettingsFromDraft,
  mapDraftState,
  playerUniverse,
  startingSlotCodes,
  eligibleSlotsFor,
  mapRoster,
  mapFreeAgent,
  buildStarters,
  type SleeperDraftRaw,
  type SleeperLeagueRaw,
  type SleeperPickRaw,
  type SleeperRosterRaw,
  type StatBundle,
} from "../src/providers/sleeper/maps.js";
import type { SleeperPlayer } from "../src/intel/match.js";

test("detectScoring reads scoring_settings.rec", () => {
  expect(detectScoring({ rec: 1 })).toBe("ppr");
  expect(detectScoring({ rec: 0.5 })).toBe("half-ppr");
  expect(detectScoring({ rec: 0 })).toBe("standard");
  expect(detectScoring(undefined)).toBe("standard");
});

const league: SleeperLeagueRaw = {
  total_rosters: 10,
  scoring_settings: { rec: 1 },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN", "BN", "BN", "IR"],
  draft_id: "d1",
};
const draft: SleeperDraftRaw = {
  draft_id: "d1",
  status: "drafting",
  type: "snake",
  draft_order: { u_me: 3, u_other: 1 },
  slot_to_roster_id: { "1": 7, "3": 4 },
  settings: { teams: 10, rounds: 14 },
};

test("mapSettings derives teams, scoring, starters (FLEX/SUPER_FLEX), bench; IR excluded", () => {
  const s = mapSettings(league, draft);
  expect(s.teams).toBe(10);
  expect(s.scoring).toBe("ppr");
  expect(s.draftType).toBe("snake");
  expect(s.benchSize).toBe(3);
  expect(s.starters).toEqual({
    QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, OP: 1, K: 1, DEF: 1,
  });
});

test("mapSettings falls back to the draft's slots_* when there's no league (mock draft)", () => {
  const mock: SleeperDraftRaw = {
    draft_id: "m1",
    league_id: null,
    type: "snake",
    status: "pre_draft",
    metadata: { scoring_type: "half_ppr" },
    settings: {
      teams: 8,
      rounds: 15,
      slots_qb: 1,
      slots_rb: 2,
      slots_wr: 2,
      slots_te: 1,
      slots_flex: 2,
      slots_k: 1,
      slots_def: 1,
      slots_bn: 6,
    },
  };
  // both the explicit helper and mapSettings(null, …) should agree
  for (const s of [mapSettingsFromDraft(mock), mapSettings(null, mock)]) {
    expect(s.teams).toBe(8);
    expect(s.scoring).toBe("half-ppr");
    expect(s.benchSize).toBe(6);
    expect(s.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 2, K: 1, DEF: 1 });
  }
});

test("mapSettingsFromDraft defaults scoring to ppr when scoring_type is missing", () => {
  const s = mapSettingsFromDraft({ settings: { teams: 12, slots_qb: 1, slots_bn: 5 } });
  expect(s.scoring).toBe("ppr");
  expect(s.teams).toBe(12);
});

test("mapSettingsFromDraft infers bench from rounds when slots_bn is absent", () => {
  // 10 starting slots, 15 rounds, no slots_bn -> bench is the remaining 5
  const s = mapSettingsFromDraft({
    settings: {
      teams: 10,
      rounds: 15,
      slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 2, slots_k: 1, slots_def: 1,
    },
  });
  expect(s.benchSize).toBe(5);
});

test("mapDraftState maps picks in order, with my slot and roster id", () => {
  const picks: SleeperPickRaw[] = [
    { pick_no: 2, round: 1, roster_id: 5, player_id: "200" },
    { pick_no: 1, round: 1, roster_id: 7, player_id: "100" },
    { pick_no: 3, round: 1, roster_id: 4, player_id: "", is_keeper: null }, // not yet picked
  ];
  const st = mapDraftState(draft, picks, "u_me");
  expect(st.inProgress).toBe(true);
  expect(st.drafted).toBe(false);
  expect(st.mySlot).toBe(3);
  expect(st.myTeamId).toBe(4); // slot_to_roster_id["3"]
  expect(st.picks.map((p) => p.playerId)).toEqual(["100", "200"]); // sorted, empty dropped
  expect(st.picks[0]).toMatchObject({ overall: 1, round: 1, pickInRound: 1, teamId: 7 });
});

test("mapDraftState: complete draft, and null slot when the user isn't in draft_order", () => {
  const done = mapDraftState({ ...draft, status: "complete" }, [], "stranger");
  expect(done.drafted).toBe(true);
  expect(done.inProgress).toBe(false);
  expect(done.mySlot).toBeNull();
  expect(done.myTeamId).toBeNull();
});

function sp(id: string, position: string, team: string | null, extra: Partial<SleeperPlayer> = {}): SleeperPlayer {
  return { player_id: id, full_name: `${id} name`, position, team, active: true, ...extra };
}

test("playerUniverse keeps offense + DEF, drops IDP and inactive, ids DEF by team", () => {
  const dump: SleeperPlayer[] = [
    sp("4046", "QB", "KC"),
    sp("5000", "RB", "DET"),
    sp("KC", "DEF", null), // Sleeper keys DEF by team code
    sp("9999", "LB", "SF"), // IDP — dropped
    sp("8888", "WR", "NYJ", { active: false }), // inactive — dropped
    sp("7777", "WR", null), // no team — dropped
  ];
  const u = playerUniverse(dump);
  expect(u.map((e) => e.player.id).sort()).toEqual(["4046", "5000", "KC"]);
  const def = u.find((e) => e.player.position === "DEF")!;
  expect(def.player).toMatchObject({ id: "KC", team: "KC", name: "KC DEF" });
});

test("startingSlotCodes expands roster_positions, dropping bench/IR", () => {
  expect(
    startingSlotCodes(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "IR"]),
  ).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "W/R/T", "K", "DEF"]);
});

test("eligibleSlotsFor adds flex / superflex eligibility", () => {
  expect(eligibleSlotsFor("RB", sp("x", "RB", "KC", { fantasy_positions: ["RB"] }))).toEqual(["RB", "W/R/T", "OP"]);
  expect(eligibleSlotsFor("QB", sp("x", "QB", "KC", { fantasy_positions: ["QB"] }))).toEqual(["QB", "OP"]);
  expect(eligibleSlotsFor("K", sp("x", "K", "KC", { fantasy_positions: ["K"] }))).toEqual(["K"]);
  expect(eligibleSlotsFor("DEF", undefined)).toEqual(["DEF"]);
});

const bundle = (over: Partial<StatBundle> = {}): StatBundle => ({
  week: new Map<string, number>(),
  season: new Map<string, number>(),
  actual: new Map<string, number>(),
  ...over,
});

test("mapRoster: starter slots align with roster_positions, reserve is IR, rest is BN", () => {
  const positions = ["QB", "RB", "RB", "WR", "FLEX", "K", "DEF", "BN", "BN"];
  const roster: SleeperRosterRaw = {
    owner_id: "u1",
    players: ["qb", "rb1", "rb2", "wr1", "flex1", "k1", "def1", "bench1", "ir1"],
    starters: ["qb", "rb1", "rb2", "wr1", "flex1", "k1", "def1"],
    reserve: ["ir1"],
  };
  const byId = new Map<string, SleeperPlayer>([
    ["qb", sp("qb", "QB", "KC", { fantasy_positions: ["QB"] })],
    ["rb1", sp("rb1", "RB", "DET", { fantasy_positions: ["RB"], injury_status: "Questionable" })],
    ["rb2", sp("rb2", "RB", "SF", { fantasy_positions: ["RB"] })],
    ["wr1", sp("wr1", "WR", "MIN", { fantasy_positions: ["WR"] })],
    ["flex1", sp("flex1", "WR", "LAR", { fantasy_positions: ["WR"] })],
    ["k1", sp("k1", "K", "BAL", { fantasy_positions: ["K"] })],
    ["def1", sp("DEF1", "DEF", null)],
    ["bench1", sp("bench1", "RB", "NYG", { fantasy_positions: ["RB"] })],
    ["ir1", sp("ir1", "WR", "MIA", { fantasy_positions: ["WR"], injury_status: "IR" })],
  ]);
  const pts = bundle({
    week: new Map([["rb1", 14.2]]),
    season: new Map([["rb1", 240]]),
    actual: new Map([["rb1", 60]]),
  });

  const players = mapRoster(roster, positions, byId, pts);
  const by = (id: string) => players.find((p) => p.id === id)!;
  expect(by("qb").currentSlot).toBe("QB");
  expect(by("flex1").currentSlot).toBe("W/R/T");
  expect(by("bench1").currentSlot).toBe("BN");
  expect(by("ir1").currentSlot).toBe("IR");
  expect(by("rb1")).toMatchObject({ projectedPoints: 14.2, seasonProjectedPoints: 240, pointsSoFar: 60, status: "Q" });
  expect(by("rb1").eligibleSlots).toEqual(["RB", "W/R/T", "OP"]);
});

test("buildStarters is the assignment player ids in slot order, '0' for an empty slot", () => {
  const p = (id: string) => ({ id, name: id, team: "KC", position: "RB", eligibleSlots: [], projectedPoints: 0, status: "OK" as const, currentSlot: "BN" });
  const plan = {
    assignments: [
      { slot: { code: "QB", index: 0 }, player: p("qb1") },
      { slot: { code: "RB", index: 0 }, player: p("rb1") },
      { slot: { code: "RB", index: 1 }, player: null },
      { slot: { code: "K", index: 0 }, player: p("k1") },
    ],
    bench: [],
    totalProjected: 0,
  };
  expect(buildStarters(plan)).toEqual(["qb1", "rb1", "0", "k1"]);
});

test("mapFreeAgent fills projections and turns a trend count into buzz", () => {
  const player = sp("7891", "WR", "SEA", { fantasy_positions: ["WR"], injury_status: "Doubtful" });
  const pts = bundle({
    week: new Map([["7891", 9.1]]),
    season: new Map([["7891", 130]]),
    actual: new Map([["7891", 22]]),
  });
  const fa = mapFreeAgent(player, pts, 50000);
  expect(fa).toMatchObject({
    id: "7891",
    position: "WR",
    weekProj: 9.1,
    seasonProj: 130,
    actualSoFar: 22,
    availability: "FA",
    status: "D",
  });
  expect(fa.eligibleSlots).toContain("W/R/T");
  expect(fa.pctChange).toBeGreaterThan(0);
  expect(fa.pctChange).toBeLessThanOrEqual(1);
  expect(mapFreeAgent(player, pts, 0).pctChange).toBe(0);
});
