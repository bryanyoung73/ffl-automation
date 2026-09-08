import { test, expect } from "@playwright/test";
import {
  detectScoring,
  mapSettings,
  mapSettingsFromDraft,
  mapDraftState,
  playerUniverse,
  type SleeperDraftRaw,
  type SleeperLeagueRaw,
  type SleeperPickRaw,
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
