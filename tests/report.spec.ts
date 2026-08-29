import { test, expect } from "@playwright/test";
import { buildCheatSheet, renderReport, verdict } from "../src/draft/report.js";
import type { LeagueSettings, Override } from "../src/draft/types.js";

const league: LeagueSettings = {
  teams: 12,
  scoring: "ppr",
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
  benchSize: 6,
  draftType: "snake",
};

let seq = 1;
function override(partial: Partial<Override>): Override {
  const delta = partial.delta ?? 15;
  return {
    player: partial.player ?? {
      id: `p${seq++}`,
      name: `Player ${seq}`,
      position: "RB",
      team: "KC",
      bye: 10,
    },
    yahooRank: partial.yahooRank ?? 30,
    consensusRank: partial.consensusRank ?? 15,
    delta,
    direction: partial.direction ?? (delta > 0 ? "undervalued" : "overvalued"),
    signals: partial.signals ?? { adp: 14, vor: 16 },
    tier: partial.tier ?? 2,
    crossesTier: partial.crossesTier ?? true,
  };
}

test("verdict scales with the number of overrides", () => {
  expect(verdict(0)).toMatch(/solid/i);
  expect(verdict(3)).toMatch(/minor tweaks/i);
  expect(verdict(12)).toMatch(/custom pre-rank/i);
});

test("buildCheatSheet counts directions and stamps a verdict", () => {
  const overrides = [
    override({ delta: 20, direction: "undervalued" }),
    override({ delta: -18, direction: "overvalued" }),
    override({ delta: 12, direction: "undervalued" }),
  ];
  const sheet = buildCheatSheet({
    overrides,
    league,
    threshold: 10,
    positionFilter: null,
    now: new Date("2026-08-28T12:00:00Z"),
  });
  expect(sheet.counts).toEqual({ undervalued: 2, overvalued: 1 });
  expect(sheet.verdict).toMatch(/minor tweaks/i);
  expect(sheet.generatedAt).toBe("2026-08-28T12:00:00.000Z");
});

test("markdown splits undervalued and overvalued into sections", () => {
  const sheet = buildCheatSheet({
    overrides: [
      override({ delta: 20, direction: "undervalued", player: pl("Rising Star") }),
      override({ delta: -15, direction: "overvalued", player: pl("Fading Name") }),
    ],
    league,
    threshold: 10,
    positionFilter: null,
  });
  const { markdown } = renderReport(sheet);
  expect(markdown).toContain("## Draft earlier than Yahoo suggests");
  expect(markdown).toContain("Rising Star");
  expect(markdown).toContain("## Let these slide");
  expect(markdown).toContain("Fading Name");
});

test("csv has a header and one row per override", () => {
  const sheet = buildCheatSheet({
    overrides: [override({}), override({})],
    league,
    threshold: 10,
    positionFilter: null,
  });
  const { csv } = renderReport(sheet);
  const rows = csv.trim().split("\n");
  expect(rows[0]).toContain("direction,player,position");
  expect(rows).toHaveLength(3);
});

test("empty override list still renders a clean report", () => {
  const sheet = buildCheatSheet({ overrides: [], league, threshold: 10, positionFilter: null });
  const { markdown, csv, summary } = renderReport(sheet);
  expect(markdown).toMatch(/no custom ranking needed/i);
  expect(markdown).toContain("_No overrides at this threshold._");
  expect(csv.trim().split("\n")).toHaveLength(1); // header only
  expect(summary).toMatch(/solid/i);
});

function pl(name: string) {
  return { id: `x${seq++}`, name, position: "RB" as const, team: "KC", bye: 9 };
}
