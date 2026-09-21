import { test, expect } from "@playwright/test";
import { renderSeasonReport, type SeasonReport } from "../src/tracking/collect.js";
import type { WeekGrade } from "../src/tracking/grade.js";

function grade(overrides: Partial<WeekGrade> & Pick<WeekGrade, "week">): WeekGrade {
  return {
    week: overrides.week,
    recommendedTotal: overrides.recommendedTotal ?? 100,
    actualTotal: overrides.actualTotal ?? 100,
    delta: overrides.delta ?? 0,
    agreementCount: overrides.agreementCount ?? 10,
    recommendedCount: overrides.recommendedCount ?? 10,
    agreementRate: overrides.agreementRate ?? 1,
    onlyRecommended: overrides.onlyRecommended ?? [],
    onlyActual: overrides.onlyActual ?? [],
  };
}

test("renderSeasonReport says plainly when nothing is gradable yet", () => {
  const report: SeasonReport = {
    summary: { weeks: [], avgAgreementRate: 0, avgDelta: 0, weeksRecommendationWasBetter: 0, weeksActualWasBetter: 0, weeksTied: 0 },
    skipped: [{ week: 2, reason: "no recommendation was recorded before this week's first lock" }],
  };
  const text = renderSeasonReport(report);
  expect(text).toContain("No weeks are gradable yet.");
  expect(text).toContain("Not graded yet:");
  expect(text).toContain("Week 2: no recommendation was recorded before this week's first lock");
});

test("renderSeasonReport lists deviations with real points, and the season summary", () => {
  const week1 = grade({
    week: 1,
    recommendedTotal: 145.2,
    actualTotal: 152.7,
    delta: 7.5,
    agreementCount: 9,
    recommendedCount: 10,
    agreementRate: 0.9,
    onlyRecommended: [{ id: "x", name: "Benched Guy", points: 4.8 }],
    onlyActual: [{ id: "y", name: "Started Instead", points: 12.3 }],
  });
  const report: SeasonReport = {
    summary: {
      weeks: [week1],
      avgAgreementRate: 0.9,
      avgDelta: 7.5,
      weeksRecommendationWasBetter: 0,
      weeksActualWasBetter: 1,
      weeksTied: 0,
    },
    skipped: [],
  };
  const text = renderSeasonReport(report);
  expect(text).toContain("Week 1 — you scored 152.7, recommendation would have scored 145.2 (+7.5, you beat it)");
  expect(text).toContain("Agreement: 9/10 players (90%)");
  expect(text).toContain("+ Started Instead (12.3 pts)");
  expect(text).toContain("- Benched Guy (4.8 pts)");
  expect(text).toContain("Season: 1 week graded");
  expect(text).toContain("Avg delta: +7.5 pts/week");
  expect(text).not.toContain("Not graded yet:"); // nothing was skipped
});

test("renderSeasonReport labels a loss and a tie correctly", () => {
  const lossWeek = grade({ week: 1, recommendedTotal: 150, actualTotal: 140, delta: -10 });
  const tieWeek = grade({ week: 2, recommendedTotal: 100, actualTotal: 100, delta: 0 });
  const text = renderSeasonReport({
    summary: { weeks: [lossWeek, tieWeek], avgAgreementRate: 1, avgDelta: -5, weeksRecommendationWasBetter: 1, weeksActualWasBetter: 0, weeksTied: 1 },
    skipped: [],
  });
  expect(text).toContain("(-10.0, recommendation would have won)");
  expect(text).toContain("(+0.0, tied)");
});
