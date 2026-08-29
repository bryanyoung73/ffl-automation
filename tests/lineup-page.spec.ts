import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { loadConfig } from "../src/config.js";
import { LineupPage } from "../src/pages/LineupPage.js";

/**
 * Live check against Yahoo using the saved session. Verifies the page objects
 * still read real data after a Yahoo UI change. Never submits anything.
 *
 * Auto-skips when there's no saved session (fresh clone / CI), so `npm test`
 * stays green without credentials.
 */
const config = loadConfig();
const hasSession = existsSync(config.storageStatePath);

test.skip(!hasSession, "no saved session — run `npm run login` first");

test("reads a non-empty roster with projections", async ({ browser }) => {
  const context = await browser.newContext({ storageState: config.storageStatePath });
  const page = await context.newPage();
  try {
    const lineup = new LineupPage(page, config);
    await lineup.goto();

    const { players, startingSlotCodes } = await lineup.readRoster();

    expect(players.length).toBeGreaterThan(5);
    expect(startingSlotCodes.length).toBeGreaterThan(0);
    // At least some players should carry a projection.
    expect(players.some((p) => p.projectedPoints > 0)).toBe(true);
    // Every player has a name and a normalized slot.
    for (const p of players) {
      expect(p.name).not.toBe("");
      expect(p.currentSlot).toMatch(/^[A-Z/]+$/);
    }
  } finally {
    await context.close();
  }
});
