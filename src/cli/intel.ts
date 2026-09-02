import { loadConfig } from "../config.js";
import { getProvider } from "../providers/index.js";
import { collectIntel } from "../intel/collect.js";
import { hasFlag } from "./prompt.js";

/**
 * Preview the chatter/news intel for the current roster.
 *
 * Flags:
 *   --refresh    ignore the cache; re-fetch every source
 *   --season     show season-horizon impact instead of week
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const useSeason = hasFlag("season");
  const provider = getProvider(config);
  try {
    const { players } = await provider.getRoster(config.week);
    const bundle = await collectIntel(config, players, { force: hasFlag("refresh") });

    console.log(
      `Intel for ${players.length} players · week ${bundle.week} · as of ${bundle.fetchedAt}\n`,
    );

    const rows = players
      .map((p) => ({ p, intel: bundle.intel.get(p.id) }))
      .filter((r) => r.intel && (r.intel.notes.length > 0 || impact(r.intel, useSeason) !== 0))
      .sort((a, b) => Math.abs(impact(b.intel!, useSeason)) - Math.abs(impact(a.intel!, useSeason)));

    if (rows.length === 0) {
      console.log("No notable chatter for this roster.");
      return;
    }

    for (const { p, intel } of rows) {
      const imp = impact(intel!, useSeason);
      console.log(`${p.name} (${p.position} ${p.team})  ${useSeason ? "season" : "week"} impact ${imp >= 0 ? "+" : ""}${imp.toFixed(1)}  conf ${intel!.confidence.toFixed(2)}`);
      for (const n of intel!.notes) {
        console.log(`   [${n.source}] ${n.text}${n.url ? `  ${n.url}` : ""}`);
      }
      console.log();
    }
  } finally {
    await provider.close();
  }
}

function impact(intel: { weekImpact: number; seasonImpact: number }, season: boolean): number {
  return season ? intel.seasonImpact : intel.weekImpact;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
