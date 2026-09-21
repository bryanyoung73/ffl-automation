import { loadConfig } from "../config.js";
import { buildSeasonReport, renderSeasonReport } from "../tracking/collect.js";

/**
 * Season-to-date recommendation-tracking report: how often the optimizer's
 * last pre-lock recommendation matched what actually got played, and who
 * scored more when they differed. Reads already-recorded snapshots
 * (`npm run lineup` / the dashboard record one on every computed plan);
 * only `getWeekResult` + the scoreboard fetches touch the network.
 * ESPN only for now — see docs/specs/2026-09-21-recommendation-tracking.md.
 *
 *   npm run track:review
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const report = await buildSeasonReport(config);
  console.log(renderSeasonReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
