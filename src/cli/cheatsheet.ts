import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { buildBoard } from "../draft/board.js";
import { renderBoard } from "../draft/report.js";
import { POSITIONS, type Position } from "../draft/types.js";
import { hasFlag } from "./prompt.js";
import { collectIntel, intelCacheDir } from "../intel/collect.js";
import { fetchEcr, attachEcr } from "../draft/ecr.js";
import type { PlayerIntel } from "../intel/types.js";

/**
 * Build a printable draft cheat sheet: every player ordered by ADP (fallback
 * expert rank), split into snake-round tiers, flagged where the source's expert
 * rank diverges from ADP, and annotated with chatter/news intel. Read-only.
 *
 * Flags:
 *   --threshold <n>    expert-vs-ADP-rank gap to flag a player (default: env)
 *   --pos <POS>        restrict to QB|RB|WR|TE|K|DEF
 *   --blend            reorder the board by ADP shifted by chatter impact
 *   --no-ecr           don't fetch FantasyPros consensus (use the source's rank)
 *   --no-intel         skip the chatter/news pass
 *   --llm              use the LLM news digest (needs ANTHROPIC_API_KEY)
 *   --intel-depth <n>  players (by ADP) to gather intel for (default: teams * 8)
 *   --refresh          force-refresh the intel cache
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const threshold = intFlag("threshold") ?? config.overrideThreshold;
  const positionFilter = posFlag();
  const blend = hasFlag("blend");
  const withIntel = !hasFlag("no-intel");

  const provider = getProvider(config);
  const sourceLabel = providerLabel(config);
  try {
    console.log("Reading league settings...");
    const league = await provider.getLeagueSettings();
    console.log(`  ${league.teams}-team ${league.scoring}`);

    console.log(`Reading ${sourceLabel} draft board...`);
    let entries = await provider.getDraftBoard();
    console.log(`  ${entries.length} players (${entries.filter((p) => p.adp != null).length} with ADP)`);

    if (!hasFlag("no-ecr")) {
      const ecr = await fetchEcr(intelCacheDir(config), league.scoring, { force: hasFlag("refresh") });
      if (ecr.length) {
        const res = attachEcr(entries, ecr);
        entries = res.entries;
        console.log(`  ${res.matched}/${entries.length} matched to FantasyPros ECR (${league.scoring})`);
      } else {
        console.log("  FantasyPros ECR unavailable — using the source's own rank");
      }
    }

    let intel: ReadonlyMap<string, PlayerIntel> | undefined;
    let intelAsOf = "";
    if (withIntel) {
      const depth = intFlag("intel-depth") ?? league.teams * 8;
      const forIntel = [...entries]
        .sort((a, b) => (a.adp ?? a.xRank ?? 9999) - (b.adp ?? b.xRank ?? 9999))
        .slice(0, depth)
        .map((e) => ({
          id: e.player.id,
          name: e.player.name,
          team: e.player.team,
          position: e.player.position,
        }));
      console.log(`Gathering chatter for the top ${forIntel.length}...`);
      const bundle = await collectIntel(config, forIntel, {
        scope: "draft",
        force: hasFlag("refresh"),
        llm: hasFlag("llm"),
      });
      intel = bundle.intel;
      intelAsOf = bundle.fetchedAt;
      console.log(`  ${bundle.intel.size} players with notes`);
    }

    const withVor = entries.some((e) => (e.projectedPoints ?? 0) > 0);
    if (withVor) console.log("  season projections present — VOR enabled");

    const board = buildBoard(entries, {
      teams: league.teams,
      threshold,
      position: positionFilter,
      sourceLabel,
      intel,
      blend,
      intelAsOf,
      leagueSettings: league,
    });
    const { markdown, csv, summary } = renderBoard(board);

    const dir = config.outputDir;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = positionFilter ? `-${positionFilter.toLowerCase()}` : "";
    const mdPath = resolve(dir, `cheatsheet-${stamp}${suffix}.md`);
    const csvPath = resolve(dir, `cheatsheet-${stamp}${suffix}.csv`);
    await writeFile(mdPath, markdown, "utf8");
    await writeFile(csvPath, csv, "utf8");

    console.log(`\n${summary}\n`);
    console.log(`Wrote ${mdPath}`);
    console.log(`Wrote ${csvPath}`);
  } finally {
    await provider.close();
  }
}

function intFlag(name: string): number | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i === -1 || !args[i + 1]) return undefined;
  const n = Number.parseInt(args[i + 1]!, 10);
  return Number.isNaN(n) ? undefined : n;
}

function posFlag(): Position | null {
  const args = process.argv.slice(2);
  const i = args.indexOf("--pos");
  if (i === -1 || !args[i + 1]) return null;
  const p = args[i + 1]!.toUpperCase() as Position;
  if (!POSITIONS.includes(p)) throw new Error(`--pos must be one of ${POSITIONS.join(", ")}`);
  return p;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
