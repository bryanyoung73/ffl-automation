import { test, expect } from "@playwright/test";
import { isPlayerBlurb, scoreHeadline } from "../src/intel/providers/espnNews.js";

test("isPlayerBlurb accepts beat-writer blurbs, rejects roundups", () => {
  expect(isPlayerBlurb("Gibbs had a strong day in the Lions' final practice", "Jahmyr Gibbs")).toBe(true);
  expect(isPlayerBlurb("Brown isn't in uniform for Thursday's preseason game", "A.J. Brown")).toBe(true);
  expect(isPlayerBlurb("Mahomes (knee) on track to start Week 1", "Patrick Mahomes")).toBe(true);

  expect(
    isPlayerBlurb("Fantasy Football 'Do Draft' list: Henry, Mahomes among undervalued", "Patrick Mahomes"),
  ).toBe(false);
  expect(isPlayerBlurb("Fantasy football sleepers, busts and breakouts for 2026", "Jahmyr Gibbs")).toBe(false);
  expect(isPlayerBlurb("Adam Schefter's fantasy football cheat sheet", "A.J. Brown")).toBe(false);
});

test("scoreHeadline: unambiguous injury/return language only", () => {
  expect(scoreHeadline("Player ruled out for Sunday").week).toBe(-3);
  expect(scoreHeadline("did not practice Wednesday").week).toBe(-1.5);
  expect(scoreHeadline("listed as questionable with an ankle issue").week).toBe(-0.7);
  expect(scoreHeadline("on track to play Week 1").week).toBeGreaterThan(0);
  expect(scoreHeadline("named the starter at running back").season).toBe(1);
  expect(scoreHeadline("caught two passes in Sunday's win")).toEqual({ week: 0, season: 0 });
});
