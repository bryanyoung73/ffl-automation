import { test, expect } from "@playwright/test";
import { rolePartial } from "../src/intel/providers/sleeper.js";
import type { SleeperPlayer } from "../src/intel/match.js";

function sp(p: Partial<SleeperPlayer>): SleeperPlayer {
  return { player_id: "x", position: "RB", ...p };
}

test("backup QB is a hard fade", () => {
  const r = rolePartial(sp({ position: "QB", depth_chart_order: 2, age: 27, years_exp: 4 }));
  expect(r.seasonImpact).toBeLessThanOrEqual(-3);
  expect(r.weekImpact).toBeLessThanOrEqual(-3);
  expect(r.notes?.[0]?.text).toMatch(/backup qb/i);
});

test("RB behind the starter takes a season hit that deepens down the chart", () => {
  const rb2 = rolePartial(sp({ position: "RB", depth_chart_order: 2, age: 25 }));
  const rb3 = rolePartial(sp({ position: "RB", depth_chart_order: 3, age: 25 }));
  expect(rb2.seasonImpact).toBeLessThan(0);
  expect(rb3.seasonImpact!).toBeLessThan(rb2.seasonImpact!);
  expect(rb2.notes?.[0]?.text).toMatch(/depth chart \(RB2\)/i);
});

test("aging RB carries age-curve risk; WR at the same age does not", () => {
  const rb = rolePartial(sp({ position: "RB", depth_chart_order: 1, age: 31 }));
  const wr = rolePartial(sp({ position: "WR", depth_chart_order: 1, age: 31 }));
  expect(rb.seasonImpact).toBeLessThan(0);
  expect(rb.notes?.some((n) => /age 31/i.test(n.text))).toBe(true);
  // WR age curve is gentler — 31 is not yet flagged
  expect(wr.notes ?? []).toHaveLength(0);
});

test("rookie gets a context note but no impact", () => {
  const r = rolePartial(sp({ position: "WR", depth_chart_order: 1, age: 22, years_exp: 0 }));
  expect(r.notes?.[0]?.text).toMatch(/rookie/i);
  expect(r.seasonImpact ?? 0).toBe(0);
});

test("a clear, prime-age starter produces nothing", () => {
  expect(rolePartial(sp({ position: "RB", depth_chart_order: 1, age: 25, years_exp: 3 }))).toEqual({});
  expect(rolePartial(sp({ position: "K", depth_chart_order: 1, age: 30 }))).toEqual({});
});
