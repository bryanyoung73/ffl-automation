import { test, expect } from "@playwright/test";
import { protectedIds, buildAddDrops } from "../src/waivers/pairs.js";
import type { FreeAgent, PlayerValue } from "../src/waivers/types.js";
import type { Player } from "../src/lineup/types.js";
import type { LeagueSettings } from "../src/draft/types.js";
import type { PlayerIntel } from "../src/intel/types.js";

const settings: LeagueSettings = {
  teams: 2,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 5,
  draftType: "snake",
};

/** Mirror ESPN: skill players are OP-eligible; RB/WR/TE also W/R/T-eligible. */
function slots(pos: string): string[] {
  const s = [pos];
  if (["RB", "WR", "TE"].includes(pos)) s.push("W/R/T");
  if (["QB", "RB", "WR", "TE"].includes(pos)) s.push("OP");
  return s;
}

function player(p: Partial<Player> & { id: string; position: string }): Player {
  return {
    name: p.id,
    team: "KC",
    eligibleSlots: slots(p.position),
    projectedPoints: 8,
    status: "OK",
    currentSlot: "BN",
    ...p,
  };
}

function fa(id: string, position: string): FreeAgent {
  return {
    id,
    name: id,
    team: "SF",
    position,
    eligibleSlots: slots(position),
    weekProj: 10,
    seasonProj: 170,
    actualSoFar: 0,
    availability: "FA",
    pctOwned: 20,
    pctChange: 0,
    status: "OK",
    bye: null,
  };
}

const v = (id: string, blended: number, extra: Partial<PlayerValue> = {}): [string, PlayerValue] => [
  id,
  { id, rosVal: blended, weekVal: blended, buzz: 0, blended, ...extra },
];

test("protectedIds shields IR, thin positions, risers, and rookies", () => {
  const roster: Player[] = [
    player({ id: "ir", position: "RB", currentSlot: "IR" }),
    player({ id: "rb-a", position: "RB" }),
    player({ id: "rb-b", position: "RB" }),
    player({ id: "rb-c", position: "RB" }),
    player({ id: "te-only", position: "TE" }), // only TE => thin
    player({ id: "riser", position: "WR" }),
    player({ id: "wr-b", position: "WR" }),
    player({ id: "wr-c", position: "WR" }),
    player({ id: "rook", position: "WR" }),
  ];
  const intel = new Map<string, PlayerIntel>([
    ["riser", { playerKey: "riser", notes: [], seasonImpact: 1, weekImpact: 0, confidence: 0.5, asOf: "" }],
    ["rook", { playerKey: "rook", notes: [{ text: "Rookie — role still projecting", source: "sleeper", horizon: "season", asOf: "" }], seasonImpact: 0, weekImpact: 0, confidence: 0.5, asOf: "" }],
  ]);
  const prot = protectedIds(roster, settings, intel);
  expect(prot.has("ir")).toBe(true);
  expect(prot.has("te-only")).toBe(true); // 1 TE, 1 TE slot -> no depth
  expect(prot.has("riser")).toBe(true);
  expect(prot.has("rook")).toBe(true);
  expect(prot.has("rb-c")).toBe(false); // 4 RBs for 2 slots -> droppable
});

test("pairs the best add with the lowest-value legal drop, past the margin", () => {
  const roster: Player[] = [
    player({ id: "rb1", position: "RB" }),
    player({ id: "rb2", position: "RB" }),
    player({ id: "rb3", position: "RB" }),
    player({ id: "dead", position: "RB" }), // lowest value, droppable
    player({ id: "wr1", position: "WR" }),
    player({ id: "wr2", position: "WR" }),
    player({ id: "wr3", position: "WR" }),
  ];
  const fas = [fa("stud", "RB"), fa("meh", "RB")];
  const faValues = new Map([v("stud", 20), v("meh", 6)]);
  const rosterValues = new Map([
    v("rb1", 18), v("rb2", 15), v("rb3", 12), v("dead", 4),
    v("wr1", 16), v("wr2", 14), v("wr3", 11),
  ]);

  const rep = buildAddDrops(fas, faValues, roster, rosterValues, {
    week: 5,
    settings,
    rosWeight: 0.7,
    margin: 1.5,
  });
  expect(rep.pairs).toHaveLength(1);
  expect(rep.pairs[0]!.add.id).toBe("stud");
  expect(rep.pairs[0]!.drop!.id).toBe("dead");
  expect(rep.pairs[0]!.gain).toBe(16);
  // "meh" (6) doesn't beat "dead" (4) by the 1.5 margin
});

test("a position whose bench beats the pool shows up as skipped", () => {
  const roster: Player[] = [
    player({ id: "rb1", position: "RB" }),
    player({ id: "rb2", position: "RB" }),
    player({ id: "rb3", position: "RB" }),
    player({ id: "rb4", position: "RB" }),
    player({ id: "wr1", position: "WR" }),
    player({ id: "wr2", position: "WR" }),
    player({ id: "wr3", position: "WR" }),
  ];
  const fas = [fa("weakwr", "WR")];
  const faValues = new Map([v("weakwr", 3)]);
  const rosterValues = new Map([
    v("rb1", 18), v("rb2", 15), v("rb3", 12), v("rb4", 9),
    v("wr1", 16), v("wr2", 14), v("wr3", 11),
  ]);
  const rep = buildAddDrops(fas, faValues, roster, rosterValues, { week: 5, settings, rosWeight: 0.7 });
  expect(rep.pairs).toHaveLength(0);
  expect(rep.skippedPositions).toContain("WR");
});

test("a QB isn't a legal drop for an RB add unless the league starts a superflex", () => {
  // ESPN tags QBs as OP-eligible; without an OP starting slot they must not
  // count as flex competition for an RB.
  const roster: Player[] = [
    player({ id: "qb-starter", position: "QB", eligibleSlots: ["QB", "OP"] }),
    player({ id: "qb-backup", position: "QB", eligibleSlots: ["QB", "OP"] }),
    player({ id: "rb1", position: "RB" }),
    player({ id: "rb2", position: "RB" }),
    player({ id: "rb3", position: "RB" }),
    player({ id: "rb4", position: "RB" }),
    player({ id: "rb5", position: "RB" }), // deep RB group so rb5 is droppable
  ];
  const fas = [fa("rbAdd", "RB")];
  const faValues = new Map([v("rbAdd", 20)]);
  const rosterValues = new Map([
    v("qb-starter", 22), v("qb-backup", 1),
    v("rb1", 18), v("rb2", 15), v("rb3", 12), v("rb4", 9), v("rb5", 5),
  ]);

  const withOp = (n: number): LeagueSettings => ({
    ...settings,
    starters: { ...settings.starters, OP: n } as LeagueSettings["starters"],
  });

  const noSuperflex = buildAddDrops(fas, faValues, roster, rosterValues, {
    week: 5,
    settings: withOp(0),
    rosWeight: 0.7,
  });
  expect(noSuperflex.pairs[0]?.drop?.id).toBe("rb5"); // lowest RB, not the QB

  const superflex = buildAddDrops(fas, faValues, roster, rosterValues, {
    week: 5,
    settings: withOp(1),
    rosWeight: 0.7,
  });
  expect(superflex.pairs[0]?.drop?.id).toBe("qb-backup"); // now the QB competes and is lowest
});

test("streaming pairs DEF on this-week value only", () => {
  const roster: Player[] = [player({ id: "myD", position: "DEF", currentSlot: "DEF" })];
  const fas = [fa("goodD", "DEF")];
  const faValues = new Map([["goodD", { id: "goodD", rosVal: 1, weekVal: 11, buzz: 0, blended: 4 }]]);
  const rosterValues = new Map([["myD", { id: "myD", rosVal: 1, weekVal: 6, buzz: 0, blended: 3 }]]);
  const rep = buildAddDrops(fas, faValues, roster, rosterValues, {
    week: 5,
    settings,
    rosWeight: 0.7,
    streamMargin: 2,
  });
  expect(rep.streaming).toHaveLength(1);
  expect(rep.streaming[0]!.add.id).toBe("goodD");
  expect(rep.streaming[0]!.drop!.id).toBe("myD");
  expect(rep.streaming[0]!.gain).toBe(5);
});
