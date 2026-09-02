import { test, expect } from "@playwright/test";
import { buildBoard, type BoardEntry } from "../src/draft/board.js";
import { renderBoard } from "../src/draft/report.js";
import type { LeagueSettings, Position } from "../src/draft/types.js";

const league: LeagueSettings = {
  teams: 2,
  scoring: "ppr",
  starters: { QB: 1, RB: 1, WR: 1 },
  benchSize: 3,
  draftType: "snake",
};

let seq = 1;
function entry(opts: { pos: Position; adp: number; proj: number; name?: string }): BoardEntry {
  const id = `p${seq++}`;
  return {
    player: { id, name: opts.name ?? id, position: opts.pos, team: "KC", bye: 7 },
    xRank: opts.adp,
    adp: opts.adp,
    listRank: opts.adp,
    projectedPoints: opts.proj,
  };
}

test("no VOR without leagueSettings, and no column in the table", () => {
  seq = 1;
  const board = buildBoard([entry({ pos: "RB", adp: 1, proj: 300 })], { teams: 2 });
  expect(board.rows[0]?.vor).toBeNull();
  expect(renderBoard(board).markdown).not.toContain("| VOR |");
});

test("VOR is computed from projections + settings; replacement is the best non-starter", () => {
  seq = 1;
  // 2-team league, 1 RB starter each => top 2 RBs start, RB3 is replacement.
  const entries = [
    entry({ pos: "RB", adp: 1, proj: 320, name: "RB1" }),
    entry({ pos: "RB", adp: 2, proj: 300, name: "RB2" }),
    entry({ pos: "RB", adp: 5, proj: 250, name: "RB3" }), // replacement level
    entry({ pos: "WR", adp: 3, proj: 280, name: "WR1" }),
    entry({ pos: "WR", adp: 4, proj: 270, name: "WR2" }),
    entry({ pos: "WR", adp: 6, proj: 200, name: "WR3" }), // replacement level
    entry({ pos: "QB", adp: 7, proj: 400, name: "QB1" }),
    entry({ pos: "QB", adp: 8, proj: 300, name: "QB2" }),
    entry({ pos: "QB", adp: 9, proj: 260, name: "QB3" }), // replacement level
  ];
  const board = buildBoard(entries, { teams: 2, leagueSettings: league });
  const by = Object.fromEntries(board.rows.map((r) => [r.player.name, r]));

  expect(by.RB1!.vor).toBe(70); // 320 - 250
  expect(by.WR1!.vor).toBe(80); // 280 - 200
  expect(by.QB1!.vor).toBe(140); // 400 - 260 (QB scarcity)
  // QB1 goes 7th by ADP but is the top VOR player
  expect(by.QB1!.vorRank).toBe(1);
  expect(by.QB1!.vorGap).toBe(1 - by.QB1!.rank); // negative — worth more than the pick
  expect(by.QB1!.vorGap).toBeLessThan(0);
});

test("renderBoard shows a VOR column with a gap arrow and a summary section", () => {
  seq = 1;
  const entries = [
    entry({ pos: "QB", adp: 8, proj: 400, name: "LateQB" }),
    ...Array.from({ length: 7 }, (_, i) =>
      entry({ pos: i % 2 ? "RB" : "WR", adp: i + 1, proj: 300 - i * 10, name: `P${i + 1}` }),
    ),
  ];
  const board = buildBoard(entries, { teams: 2, leagueSettings: league });
  const { markdown, csv, summary } = renderBoard(board);

  expect(markdown).toContain("| VOR |");
  expect(markdown).toMatch(/LateQB \| QB \| KC \| 7 \|[^|]*\|[^|]*\| \d+ ↑\d+ \|/); // value + up-arrow
  expect(summary).toContain("Positional value (VOR) vs the board:");
  expect(csv.split("\n")[0]).toContain(",vor,vor_rank,vor_gap,");
});
