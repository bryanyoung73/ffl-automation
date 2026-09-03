import { test, expect } from "@playwright/test";
import { willLast } from "../src/draft/live/survival.js";

test("a player whose ADP is well before my pick is gone", () => {
  const s = willLast(20, 45);
  expect(s.bucket).toBe("gone");
  expect(s.prob!).toBeLessThan(0.15);
});

test("a player whose ADP is well after my pick is safe", () => {
  const s = willLast(60, 45);
  expect(s.bucket).toBe("safe");
  expect(s.prob!).toBeGreaterThan(0.6);
});

test("a player going right around my pick is a coin flip", () => {
  const s = willLast(44, 45);
  expect(s.bucket).toBe("coinflip");
  expect(s.prob!).toBeGreaterThan(0.15);
  expect(s.prob!).toBeLessThan(0.6);
});

test("the same absolute gap is riskier early than late (sigma widens with ADP)", () => {
  const early = willLast(10, 20); // gap 10, sigma floored at 4
  const late = willLast(150, 160); // gap 10, sigma near the ceiling
  expect(early.bucket).toBe("gone");
  expect(late.bucket).toBe("coinflip");
  expect(late.prob!).toBeGreaterThan(early.prob!);
});

test("no ADP → cannot reason, not penalised", () => {
  expect(willLast(null, 45)).toEqual({ prob: null, bucket: "safe" });
});

test("prob stays within [0, 1]", () => {
  expect(willLast(1, 200).prob!).toBeGreaterThanOrEqual(0);
  expect(willLast(200, 1).prob!).toBeLessThanOrEqual(1);
});
