import { test, expect } from "@playwright/test";
import { buildBoard, type BoardEntry } from "../src/draft/board.js";
import { renderBoard } from "../src/draft/report.js";
import type { PlayerIntel } from "../src/intel/types.js";

let seq = 1;
function entry(adp: number, name?: string): BoardEntry {
  const id = `p${seq++}`;
  return {
    player: { id, name: name ?? id, position: "RB", team: "KC", bye: 7 },
    xRank: adp,
    adp,
    listRank: adp,
  };
}

function intel(partial: Partial<PlayerIntel>): PlayerIntel {
  return {
    playerKey: "x",
    notes: [],
    seasonImpact: 0,
    weekImpact: 0,
    confidence: 0.5,
    asOf: "2026-09-02T00:00:00Z",
    ...partial,
  };
}

test("intel attaches notes without reordering when not blended", () => {
  seq = 1;
  const entries = [entry(1, "A"), entry(2, "B"), entry(3, "C")];
  const map = new Map<string, PlayerIntel>([
    ["p2", intel({ seasonImpact: 3, notes: [{ text: "beat writer loves him", source: "espn-news", horizon: "season", asOf: "2026-09-02" }] })],
  ]);
  const board = buildBoard(entries, { teams: 10, intel: map });

  expect(board.blended).toBe(false);
  expect(board.rows.map((r) => r.player.name)).toEqual(["A", "B", "C"]);
  const b = board.rows.find((r) => r.player.name === "B")!;
  expect(b.intelImpact).toBe(3);
  expect(b.intelNote).toBe("beat writer loves him");
  expect(b.blendShift).toBe(0);
  expect(b.adpRank).toBe(2);
});

test("--blend reorders by ADP shifted by seasonImpact and records the move", () => {
  seq = 1;
  // 12 evenly-spaced players; give #10 a big positive buy and #2 a big fade.
  const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1, `P${i + 1}`));
  const map = new Map<string, PlayerIntel>([
    ["p10", intel({ seasonImpact: 3 })],
    ["p2", intel({ seasonImpact: -3 })],
  ]);
  const board = buildBoard(entries, { teams: 10, intel: map, blend: true });

  expect(board.blended).toBe(true);
  const p10 = board.rows.find((r) => r.player.name === "P10")!;
  const p2 = board.rows.find((r) => r.player.name === "P2")!;
  expect(p10.adpRank).toBe(10);
  expect(p10.rank).toBeLessThan(10); // moved up
  expect(p10.blendShift).toBe(p10.adpRank - p10.rank);
  expect(p10.blendShift).toBeGreaterThan(0);
  expect(p2.rank).toBeGreaterThan(2); // moved down
  expect(p2.blendShift).toBeLessThan(0);
});

test("renderBoard shows a Chatter column, and a Δ column only when blended", () => {
  seq = 1;
  const entries = [entry(1, "Anchor"), entry(2, "Mover")];
  const map = new Map<string, PlayerIntel>([
    ["p2", intel({ seasonImpact: 2, notes: [{ text: "camp standout", source: "espn-news", horizon: "season", asOf: "2026-09-02" }] })],
  ]);

  const plain = renderBoard(buildBoard(entries, { teams: 10, intel: map }));
  expect(plain.markdown).toContain("| Chatter |");
  expect(plain.markdown).not.toContain("| Δ |");
  expect(plain.markdown).toContain("camp standout");
  expect(plain.summary).toContain("Chatter:");

  seq = 1;
  const blended = renderBoard(buildBoard([entry(1, "Anchor"), entry(2, "Mover")], { teams: 10, intel: new Map([["p2", intel({ seasonImpact: 2 })]]), blend: true }));
  expect(blended.markdown).toContain("| Δ |");
});

test("csv carries the intel columns", () => {
  seq = 1;
  const entries = [entry(1, "A"), entry(2, "B")];
  const map = new Map<string, PlayerIntel>([
    ["p1", intel({ seasonImpact: -1.5, weekImpact: -2, notes: [
      { text: "hamstring, DNP", source: "sleeper", horizon: "week", asOf: "2026-09-02" },
      { text: "questionable", source: "espn-news", horizon: "week", asOf: "2026-09-01" },
    ] })],
  ]);
  const { csv } = renderBoard(buildBoard(entries, { teams: 10, intel: map }));
  const [header, rowA] = csv.trim().split("\n");
  expect(header).toContain("intel_season,intel_week,intel_note,intel_sources");
  expect(rowA).toContain("-1.5,-2,");
  expect(rowA).toContain('"hamstring, DNP"'); // csv-quoted because it has a comma
  expect(rowA).toContain("sleeper|espn-news");
});
