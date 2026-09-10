import { test, expect } from "@playwright/test";
import {
  mapSettings,
  startingSlotCodes,
  mapRosterEntry,
  mapPlayerPoolEntry,
  buildLineupItems,
} from "../src/providers/espn/EspnLeague.js";
import { optimizeLineup } from "../src/lineup/optimizer.js";
import fixture from "./fixtures/espn-league.sample.json" with { type: "json" };

const raw = fixture as Parameters<typeof mapSettings>[0];

test("mapSettings derives teams, scoring, starters, bench, draft type", () => {
  const s = mapSettings(raw);
  expect(s.teams).toBe(10);
  expect(s.scoring).toBe("ppr");
  expect(s.draftType).toBe("snake");
  expect(s.benchSize).toBe(6);
  expect(s.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 });
});

test("startingSlotCodes expands the configured starters, bench/IR excluded", () => {
  expect(startingSlotCodes(raw)).toEqual([
    "QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "K", "DEF",
  ]);
});

test("mapRosterEntry maps a starter with a weekly projection", () => {
  const entries = raw.teams![0]!.roster!.entries!;
  const p = mapRosterEntry(entries[0]!, 1);
  expect(p).toMatchObject({
    id: "3139477",
    name: "Patrick Mahomes",
    team: "KC",
    position: "QB",
    projectedPoints: 22.4,
    status: "OK",
    currentSlot: "QB",
    locked: true, // playerPoolEntry.lineupLocked — his game has started
  });
  // an entry without the flag is not locked
  expect(mapRosterEntry(entries[1]!, 1).locked).toBe(false);
});

test("mapRosterEntry carries injury status and IR slot", () => {
  const entries = raw.teams![0]!.roster!.entries!;
  const fastBack = mapRosterEntry(entries[2]!, 1);
  expect(fastBack.status).toBe("Q");
  expect(fastBack.currentSlot).toBe("BN");
  expect(fastBack.eligibleSlots.sort()).toEqual(["RB", "W/R/T"]);

  const hurt = mapRosterEntry(entries[4]!, 1);
  expect(hurt.currentSlot).toBe("IR");
  expect(hurt.status).toBe("IR");
  expect(hurt.position).toBe("TE");
});

test("mapPlayerPoolEntry builds a BoardEntry with ADP + scoring-correct expert rank", () => {
  const players = raw.players!;
  const bijan = mapPlayerPoolEntry(players[1]!, 1, "ppr");
  expect(bijan.player).toMatchObject({ name: "Bijan Robinson", position: "RB", team: "ATL", bye: 5 });
  expect(bijan.adp).toBe(2.1);
  expect(bijan.xRank).toBe(2); // PPR rank, not STANDARD
  expect(bijan.listRank).toBe(2);

  const rookie = mapPlayerPoolEntry(players[2]!, 2, "ppr");
  expect(rookie.adp).toBeNull(); // averageDraftPosition 0 -> null
  expect(rookie.xRank).toBeNull(); // no draftRanksByRankType
  expect(rookie.player.bye).toBeNull(); // byeWeek 0 -> null
});

test("buildLineupItems promotes the benched player the optimizer wants starting", () => {
  const entries = raw.teams![0]!.roster!.entries!;
  const players = entries.map((e) => mapRosterEntry(e, 1));
  const slots = startingSlotCodes(raw);
  const plan = optimizeLineup(players, slots);
  // Fast Back (17.0, benched) beats Slow Back for RB2; everyone else stays put.
  expect(buildLineupItems(plan)).toEqual([
    { playerId: 222, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 2 },
  ]);
});

test("buildLineupItems never moves a player on or off the IR slot", () => {
  const entries = raw.teams![0]!.roster!.entries!;
  const players = entries.map((e) => mapRosterEntry(e, 1));
  const slots = startingSlotCodes(raw);
  const plan = optimizeLineup(players, slots);
  // Hurt Guy sits on IR; the optimizer benches him in its plan, but that must
  // not turn into an IR->BN transaction item.
  const items = buildLineupItems(plan);
  expect(items.some((i) => i.playerId === 444)).toBe(false);
  expect(items.every((i) => i.fromLineupSlotId !== 21 && i.toLineupSlotId !== 21)).toBe(true);
});

test("buildLineupItems is empty once the lineup is settled", () => {
  const entries = raw.teams![0]!.roster!.entries!;
  const players = entries.map((e) => mapRosterEntry(e, 1));
  const slots = startingSlotCodes(raw);
  const plan = optimizeLineup(players, slots);
  const settled = players.map((p) => {
    const a = plan.assignments.find((x) => x.player?.id === p.id);
    return { ...p, currentSlot: a ? a.slot.code : p.currentSlot === "IR" ? "IR" : "BN" };
  });
  expect(buildLineupItems(optimizeLineup(settled, slots))).toEqual([]);
});
