import { loadConfig } from "../config.js";
import { getProvider } from "../providers/index.js";
import { hasFlag } from "./prompt.js";
import { applyWeeklyIntel, formatAdjustments } from "../intel/weekly.js";

/**
 * Read-only: print the current roster with projections and status.
 * Useful for sanity-checking a provider before trusting `npm run lineup`.
 *
 * Flags:
 *   --no-intel   skip the chatter/news projection adjustment
 *   --llm        use the LLM news digest (needs ANTHROPIC_API_KEY)
 *   --refresh    force-refresh the intel cache
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = getProvider(config);
  try {
    const { players: rawPlayers, startingSlotCodes } = await provider.getRoster(config.week);

    const { players, adjustments, fetchedAt, skipped } = await applyWeeklyIntel(config, rawPlayers, {
      skip: hasFlag("no-intel"),
      force: hasFlag("refresh"),
      llm: hasFlag("llm"),
    });

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

    if (!skipped) {
      console.log(`\nIntel as of ${fetchedAt || "(unknown)"}:`);
      const lines = formatAdjustments(adjustments);
      console.log(lines.length ? lines.join("\n") : "  (no notable chatter for this roster)");
    }
  } finally {
    await provider.close();
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
