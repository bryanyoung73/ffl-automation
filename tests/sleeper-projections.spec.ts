import { test, expect } from "@playwright/test";
import { parseProjections } from "../src/providers/sleeper/projections.js";

// Mirrors a Sleeper /projections row.
const RAW = [
  { player_id: "9509", player: { position: "RB" }, stats: { pts_ppr: 308.1, pts_half_ppr: 280.1, pts_std: 252.1, gp: 18 } },
  { player_id: "4881", player: { position: "QB" }, stats: { pts_ppr: 359, pts_half_ppr: 359, pts_std: 359 } },
  { player_id: "PHI", player: { position: "DEF" }, stats: { pts_ppr: 101, pts_half_ppr: 101, pts_std: 101 } },
  { player_id: "nobody", stats: {} }, // no pts -> dropped
  { player_id: "zero", stats: { pts_ppr: 0 } }, // zero -> dropped
  { stats: { pts_ppr: 50 } }, // no id -> dropped
];

test("parseProjections picks the scoring-matched field, keyed by player id", () => {
  const ppr = parseProjections(RAW, "ppr");
  expect(ppr.get("9509")).toBe(308.1);
  expect(ppr.get("4881")).toBe(359);
  expect(ppr.get("PHI")).toBe(101);
  expect(ppr.has("nobody")).toBe(false);
  expect(ppr.has("zero")).toBe(false);
  expect(ppr.size).toBe(3);
});

test("parseProjections switches fields by scoring", () => {
  expect(parseProjections(RAW, "half-ppr").get("9509")).toBe(280.1);
  expect(parseProjections(RAW, "standard").get("9509")).toBe(252.1);
});

test("parseProjections tolerates junk", () => {
  expect(parseProjections(null, "ppr").size).toBe(0);
  expect(parseProjections({ error: "x" }, "ppr").size).toBe(0);
  expect(parseProjections([], "ppr").size).toBe(0);
});
