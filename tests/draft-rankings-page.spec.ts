import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { loadConfig } from "../src/config.js";
import { DraftRankingsPage } from "../src/pages/DraftRankingsPage.js";
import { LeagueSettingsPage } from "../src/pages/LeagueSettingsPage.js";

/**
 * Live checks for the draft-prep scrapers. Auto-skip without a saved session.
 * Never writes to Yahoo.
 */
const config = loadConfig();
const hasSession = existsSync(config.storageStatePath);

test.skip(!hasSession, "no saved session — run `npm run login` first");

test("league settings parse into a sane shape", async ({ browser }) => {
  const context = await browser.newContext({ storageState: config.storageStatePath });
  const page = await context.newPage();
  try {
    const settings = await new LeagueSettingsPage(page, config).read();
    expect(settings.teams).toBeGreaterThanOrEqual(4);
    expect(settings.teams).toBeLessThanOrEqual(20);
    expect(Object.keys(settings.starters).length).toBeGreaterThan(3);
    expect(["standard", "half-ppr", "ppr"]).toContain(settings.scoring);
  } finally {
    await context.close();
  }
});

test("default pre-rank returns an ordered player list with byes", async ({ browser }) => {
  const context = await browser.newContext({ storageState: config.storageStatePath });
  const page = await context.newPage();
  try {
    const preRank = await new DraftRankingsPage(page, config).readPreRank();
    expect(preRank.length).toBeGreaterThan(50);
    expect(preRank[0]?.rank).toBe(1);
    expect(preRank.map((p) => p.rank)).toEqual(preRank.map((_, i) => i + 1));
    expect(preRank.some((p) => typeof p.bye === "number")).toBe(true);
    expect(preRank.every((p) => p.name.length > 0)).toBe(true);
  } finally {
    await context.close();
  }
});
