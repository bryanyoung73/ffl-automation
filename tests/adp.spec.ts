import { test, expect } from "@playwright/test";
import { parseAdp, attachAdp } from "../src/draft/adp.js";
import type { BoardEntry } from "../src/draft/board.js";

// Shape mirrors FantasyFootballCalculator's /api/v1/adp response.
const FFC = {
  status: "Success",
  players: [
    { player_id: 1, name: "Jahmyr Gibbs", position: "RB", team: "DET", adp: 1.4, high: 1, low: 4, stdev: 0.6, bye: 6 },
    { player_id: 2, name: "Bijan Robinson", position: "RB", team: "ATL", adp: 2.3, high: 1, low: 5, stdev: 0.7, bye: 11 },
    { player_id: 3, name: "Seattle Defense", position: "DEF", team: "SEA", adp: 80.5, high: 58, low: 97, stdev: 8.5, bye: 11 },
    { player_id: 4, name: "No ADP Guy", position: "WR", team: "KC", adp: 0, high: null, low: null, stdev: null, bye: 10 },
  ],
};

test("parseAdp maps players, carrying high/low/stdev/bye and dropping no-ADP rows", () => {
  const rows = parseAdp(FFC);
  expect(rows).toHaveLength(3); // "No ADP Guy" (adp 0) dropped
  expect(rows[0]).toEqual({
    name: "Jahmyr Gibbs",
    team: "DET",
    position: "RB",
    adp: 1.4,
    high: 1,
    low: 4,
    stdev: 0.6,
    bye: 6,
  });
  expect(rows[2]).toMatchObject({ name: "Seattle Defense", position: "DEF", team: "SEA", stdev: 8.5 });
});

test("parseAdp tolerates junk", () => {
  expect(parseAdp(null)).toEqual([]);
  expect(parseAdp({ status: "Error" })).toEqual([]);
  expect(parseAdp("nope")).toEqual([]);
});

function entry(id: string, name: string, position: string, team: string, bye: number | null = null): BoardEntry {
  return { player: { id, name, position: position as BoardEntry["player"]["position"], team, bye }, xRank: null, adp: null, listRank: 0 };
}

test("attachAdp joins by name (+team), defenses by team, and fills a missing bye", () => {
  const entries = [
    entry("p1", "Jahmyr Gibbs", "RB", "DET"),
    entry("SEA", "SEA DEF", "DEF", "SEA"),
    entry("p9", "Unmatched Man", "WR", "NYJ", 9),
  ];
  const { entries: out, matched } = attachAdp(entries, parseAdp(FFC));
  expect(matched).toBe(2);
  expect(out[0]).toMatchObject({ adp: 1.4, adpHigh: 1, adpLow: 4, adpStdev: 0.6 });
  expect(out[0]!.player.bye).toBe(6); // filled from FFC
  expect(out[1]).toMatchObject({ adp: 80.5, adpStdev: 8.5 }); // DEF matched on "SEA"
  expect(out[2]!.adp).toBeNull(); // unmatched untouched
});
