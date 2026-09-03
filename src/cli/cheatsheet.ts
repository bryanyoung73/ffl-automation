import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { assembleBoard } from "../draft/assemble.js";
import { renderBoard } from "../draft/report.js";
import { POSITIONS, type Position } from "../draft/types.js";
import { hasFlag } from "./prompt.js";

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
 *   --refresh          force-refresh the ECR + intel caches
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = getProvider(config);
  try {
    const { board } = await assembleBoard(config, provider, {
      sourceLabel: providerLabel(config),
      threshold: intFlag("threshold") ?? config.overrideThreshold,
      position: posFlag(),
      blend: hasFlag("blend"),
      noEcr: hasFlag("no-ecr"),
      noIntel: hasFlag("no-intel"),
      llm: hasFlag("llm"),
      refresh: hasFlag("refresh"),
      intelDepth: intFlag("intel-depth"),
      log: (m) => console.log(m),
    });
    const { markdown, csv, summary } = renderBoard(board);

    const dir = config.outputDir;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = board.positionFilter ? `-${board.positionFilter.toLowerCase()}` : "";
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
