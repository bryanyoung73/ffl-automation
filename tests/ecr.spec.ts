import { test, expect } from "@playwright/test";
import { parseEcrHtml, attachEcr } from "../src/draft/ecr.js";
import { buildBoard, type BoardEntry } from "../src/draft/board.js";
import { renderBoard } from "../src/draft/report.js";

const HTML = `
<html><head></head><body>
<script>
var somethingElse = {"a":1};
var ecrData = {"sport":"NFL","type":"Draft PPR","players":[
  {"player_id":1,"player_name":"Ja'Marr Chase","player_team_id":"CIN","player_position_id":"WR","rank_ecr":1,"pos_rank":"WR1","tier":1,"player_ecr_delta":null,"rank_min":"1","rank_max":"6","rank_std":"0.98"},
  {"player_id":2,"player_name":"Bijan Robinson Jr.","player_team_id":"ATL","player_position_id":"RB","rank_ecr":2,"pos_rank":"RB1","tier":1,"player_ecr_delta":-3},
  {"player_id":3,"player_name":"Broken","player_team_id":"","player_position_id":"WR","rank_ecr":null,"pos_rank":"","tier":0}
]};
</script>
</body></html>`;

test("parseEcrHtml extracts the ecrData players array", () => {
  const rows = parseEcrHtml(HTML);
  expect(rows).toHaveLength(2); // "Broken" (no rank) dropped
  expect(rows[0]).toMatchObject({ name: "Ja'Marr Chase", team: "CIN", position: "WR", ecrRank: 1, posRank: "WR1", tier: 1, rankMin: 1, rankMax: 6, rankStd: 0.98 });
  expect(rows[1]).toMatchObject({ name: "Bijan Robinson Jr.", ecrRank: 2, delta: -3, rankMin: null, rankMax: null, rankStd: null });
});

test("parseEcrHtml returns [] on a page with no ecrData", () => {
  expect(parseEcrHtml("<html>nothing here</html>")).toEqual([]);
  expect(parseEcrHtml("var ecrData = {not json;")).toEqual([]);
});

function entry(name: string, team: string, adp: number, xRank: number): BoardEntry {
  return { player: { id: name, name, position: "RB", team, bye: 7 }, xRank, adp, listRank: adp };
}

test("attachEcr joins by normalized name (+ team) and counts matches", () => {
  const entries = [
    entry("Bijan Robinson", "ATL", 2, 5), // suffix-insensitive match
    entry("Ja'Marr Chase", "CIN", 1, 1),
    entry("Nobody Special", "FA", 3, 3),
  ];
  const { entries: out, matched } = attachEcr(entries, parseEcrHtml(HTML));
  expect(matched).toBe(2);
  expect(out[0]).toMatchObject({ ecrRank: 2, ecrPosRank: "RB1", ecrTier: 1 });
  expect(out[2]?.ecrRank).toBeUndefined();
});

test("buildBoard uses ECR as the expert baseline when present", () => {
  // ADP order: A, B, C. ECR flips C ahead of A.
  const entries: BoardEntry[] = [
    { ...entry("A", "KC", 1, 1), ecrRank: 30 },
    { ...entry("B", "KC", 2, 2), ecrRank: 20 },
    { ...entry("C", "KC", 3, 3), ecrRank: 1 },
  ];
  const board = buildBoard(entries, { teams: 10, threshold: 1, sourceLabel: "ESPN" });
  expect(board.expertLabel).toBe("ECR");
  const c = board.rows.find((r) => r.player.name === "C")!;
  expect(c.yahooExpertPos).toBe(1); // best ECR
  expect(c.yahooGap).toBeLessThan(0); // experts much higher than the room
  expect(c.note).toBe("yahoo-hot");

  const { markdown } = renderBoard(board);
  expect(markdown).toContain("| ECR |");
});
