import { test, expect } from "@playwright/test";
import { normalizeName, teamCode, buildIdentityMap, type SleeperPlayer } from "../src/intel/match.js";
import type { IntelPlayerRef } from "../src/intel/types.js";

test("normalizeName lowercases, strips accents/punctuation/suffixes", () => {
  expect(normalizeName("Patrick Mahomes")).toBe("patrick mahomes");
  expect(normalizeName("D'Andre Swift")).toBe("dandre swift");
  expect(normalizeName("Michael Pittman Jr.")).toBe("michael pittman");
  expect(normalizeName("Amon-Ra St. Brown")).toBe("amon-ra st brown");
  expect(normalizeName("Kenneth Walker III")).toBe("kenneth walker");
});

test("teamCode folds provider spellings together", () => {
  expect(teamCode("JAC")).toBe("JAX");
  expect(teamCode("wsh")).toBe("WSH");
  expect(teamCode("WAS")).toBe("WSH");
  expect(teamCode("KC")).toBe("KC");
  expect(teamCode(null)).toBe("");
});

const sleeper: SleeperPlayer[] = [
  {
    player_id: "4046",
    full_name: "Patrick Mahomes",
    team: "KC",
    position: "QB",
    espn_id: 3139477,
    yahoo_id: 30977,
  },
  {
    player_id: "6813",
    first_name: "Jahmyr",
    last_name: "Gibbs",
    team: "DET",
    position: "RB",
    espn_id: 4429795,
    yahoo_id: null,
  },
  { player_id: "CHI", full_name: "Chicago Bears", team: "CHI", position: "DEF", espn_id: null },
];

test("buildIdentityMap joins by name+team and reads cross-provider ids", () => {
  const players: IntelPlayerRef[] = [
    { id: "e1", name: "Patrick Mahomes", team: "KC", position: "QB" },
    { id: "e2", name: "Jahmyr Gibbs", team: "DET", position: "RB" },
  ];
  const map = buildIdentityMap(players, sleeper);
  expect(map.get("e1")).toMatchObject({ sleeperId: "4046", espnId: "3139477", yahooId: "30977" });
  expect(map.get("e2")).toMatchObject({ sleeperId: "6813", espnId: "4429795" });
  expect(map.get("e2")?.yahooId).toBeUndefined();
});

test("buildIdentityMap matches team defenses on team + DEF", () => {
  const map = buildIdentityMap([{ id: "d1", name: "Bears D/ST", team: "CHI", position: "DEF" }], sleeper);
  expect(map.get("d1")?.sleeperId).toBe("CHI");
});

test("buildIdentityMap still returns an identity for unmatched players", () => {
  const map = buildIdentityMap([{ id: "x", name: "Nobody Here", team: "FA", position: "WR" }], sleeper);
  expect(map.get("x")).toMatchObject({ id: "x", team: "FA" });
  expect(map.get("x")?.sleeperId).toBeUndefined();
});
