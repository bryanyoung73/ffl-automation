import { loadConfig } from "../config.js";
import { openSession } from "../browser.js";
import { LineupPage } from "../pages/LineupPage.js";

/**
 * Read-only: print the current roster with projections and status.
 * Useful for sanity-checking the scraper selectors before trusting `npm run lineup`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const session = await openSession(config);
  try {
    const lineup = new LineupPage(session.page, config);
    await lineup.goto();
    const { players, startingSlotCodes } = await lineup.readRoster();

    const rows = players
      .slice()
      .sort((a, b) => rank(a.currentSlot) - rank(b.currentSlot) || b.projectedPoints - a.projectedPoints)
      .map((p) => ({
        Slot: p.currentSlot,
        Player: p.name,
        Pos: p.position,
        Team: p.team,
        Proj: p.projectedPoints.toFixed(1),
        Status: p.status === "OK" ? "" : p.status,
      }));

    console.table(rows);
    console.log(`Starting slots detected: ${startingSlotCodes.join(", ") || "(none)"}`);
    if (config.week) console.log(`Week: ${config.week}`);
  } finally {
    await session.close();
  }
}

function rank(slot: string): number {
  const order = ["QB", "RB", "WR", "TE", "W/R/T", "K", "DEF", "BN", "IR"];
  const i = order.indexOf(slot);
  return i === -1 ? order.length : i;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
