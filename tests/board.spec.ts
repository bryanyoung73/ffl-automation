import { test, expect } from "@playwright/test";
import { buildBoard, verdict, type BoardEntry } from "../src/draft/board.js";
import { renderBoard } from "../src/draft/report.js";
import type { Position } from "../src/draft/types.js";

let seq = 1;
function entry(opts: {
  xRank?: number | null;
  adp?: number | null;
  listRank: number;
  pos?: Position;
  name?: string;
}): BoardEntry {
  const id = `p${seq++}`;
  return {
    player: { id, name: opts.name ?? id, position: opts.pos ?? "RB", team: "KC", bye: 7 },
    xRank: opts.xRank ?? null,
    adp: opts.adp ?? null,
    listRank: opts.listRank,
  };
}

test("orders by ADP, falling back to XRank then list order", () => {
  const board = buildBoard(
    [
      entry({ name: "adp3", adp: 3, xRank: 1, listRank: 1 }),
      entry({ name: "adp1", adp: 1, xRank: 9, listRank: 9 }),
      entry({ name: "noAdp-xr5", adp: null, xRank: 5, listRank: 5 }),
      entry({ name: "noAdp-noXr", adp: null, xRank: null, listRank: 200 }),
    ],
    { teams: 12 },
  );
  expect(board.rows.map((r) => r.player.name)).toEqual([
    "adp1",
    "adp3",
    "noAdp-xr5",
    "noAdp-noXr",
  ]);
  expect(board.rows[0]?.rank).toBe(1);
});

test("assigns snake-round tiers from team count", () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    entry({ adp: i + 1, xRank: i + 1, listRank: i + 1 }),
  );
  const board = buildBoard(entries, { teams: 12 });
  expect(board.rows[0]?.tier).toBe(1);
  expect(board.rows[11]?.tier).toBe(1);
  expect(board.rows[12]?.tier).toBe(2);
  expect(board.rows[24]?.tier).toBe(3);
});

test("flags an early player Yahoo's experts rank far below ADP (yahoo-cold)", () => {
  // 20 aligned players, then one the room drafts 3rd but Yahoo's experts rank ~40th.
  const entries = [
    ...Array.from({ length: 20 }, (_, i) =>
      entry({ name: `f${i}`, adp: i + 1, xRank: i + 1, listRank: i + 1 }),
    ),
    entry({ name: "RoomLovesHim", adp: 2.5, xRank: 200, listRank: 40 }),
  ];
  const board = buildBoard(entries, { teams: 12, threshold: 15 });
  const row = board.rows.find((r) => r.player.name === "RoomLovesHim")!;
  expect(row.rank).toBe(3);
  expect(row.yahooExpertPos).toBe(21); // worst XRank among 21 players
  expect(row.yahooGap).toBe(18); // 21 - 3
  expect(row.note).toBe("yahoo-cold");
});

test("flags an early player Yahoo's experts rank far above ADP (yahoo-hot)", () => {
  const entries = [
    entry({ name: "YahooDarling", adp: 40, xRank: 1, listRank: 3 }),
    ...Array.from({ length: 35 }, (_, i) =>
      entry({ name: `f${i}`, adp: i + 1, xRank: i + 2, listRank: i + 2 }),
    ),
  ];
  const board = buildBoard(entries, { teams: 12, threshold: 15 });
  const row = board.rows.find((r) => r.player.name === "YahooDarling")!;
  expect(row.yahooExpertPos).toBe(1);
  expect(row.note).toBe("yahoo-hot");
  expect(row.yahooGap).toBeLessThanOrEqual(-15);
});

test("does not flag disagreements past the flagWithin cutoff", () => {
  const entries = [
    entry({ name: "EarlyGap", adp: 5.5, xRank: 999, listRank: 30 }),
    ...Array.from({ length: 40 }, (_, i) =>
      entry({ name: `f${i}`, adp: i + 1, xRank: i + 1, listRank: i + 1 }),
    ),
  ];
  const board = buildBoard(entries, { teams: 3, threshold: 12, flagWithin: 3 });
  const row = board.rows.find((r) => r.player.name === "EarlyGap")!;
  expect(row.rank).toBeGreaterThan(3); // outside the cutoff
  expect(Math.abs(row.yahooGap ?? 0)).toBeGreaterThan(12);
  expect(row.note).toBe("");
});

test("position filter restricts the board", () => {
  const board = buildBoard(
    [
      entry({ name: "RB", pos: "RB", adp: 1, listRank: 1 }),
      entry({ name: "WR", pos: "WR", adp: 2, listRank: 2 }),
    ],
    { teams: 12, position: "WR" },
  );
  expect(board.rows).toHaveLength(1);
  expect(board.rows[0]?.player.position).toBe("WR");
});

test("verdict scales with disagreement count", () => {
  expect(verdict(0, 100)).toMatch(/fine as-is/i);
  expect(verdict(3, 100)).toMatch(/mostly aligned/i);
  expect(verdict(20, 100)).toMatch(/worth a manual pass/i);
  expect(verdict(0, 0)).toMatch(/no players/i);
});

test("renderBoard produces tiered markdown and a flat csv", () => {
  const entries = Array.from({ length: 15 }, (_, i) =>
    entry({ name: `P${i + 1}`, adp: i + 1, xRank: i + 1, listRank: i + 1 }),
  );
  const board = buildBoard(entries, { teams: 12 });
  const { markdown, csv } = renderBoard(board);
  expect(markdown).toContain("# Draft cheat sheet");
  expect(markdown).toContain("## Tier 1  (picks 1–12)");
  expect(markdown).toContain("## Tier 2  (picks 13–24)");
  const rows = csv.trim().split("\n");
  expect(rows[0]).toBe(
    "rank,player,position,team,bye,adp,yahoo_expert_pos,yahoo_list_rank,xrank,yahoo_gap,tier,flag",
  );
  expect(rows).toHaveLength(16);
});
