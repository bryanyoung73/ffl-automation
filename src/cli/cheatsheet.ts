import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { openSession } from "../browser.js";
import { LeagueSettingsPage } from "../pages/LeagueSettingsPage.js";
import { DraftRankingsPage } from "../pages/DraftRankingsPage.js";
import { buildBoard, type BoardEntry } from "../draft/board.js";
import { renderBoard } from "../draft/report.js";
import { POSITIONS, type Position } from "../draft/types.js";

/**
 * Build a printable draft cheat sheet from Yahoo's Edit Pre-Draft Ranks page:
 * every player ordered by ADP (fallback XRank), split into snake-round tiers,
 * with a flag wherever Yahoo's expert rank diverges from ADP. Read-only.
 *
 * Flags:
 *   --threshold <n>   XRank-vs-ADP-rank gap to flag a player (default: env or 12)
 *   --pos <POS>       restrict to QB|RB|WR|TE|K|DEF
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const threshold = intFlag("threshold") ?? config.overrideThreshold;
  const positionFilter = posFlag();

  const session = await openSession(config);
  try {
    console.log("Reading league settings...");
    const league = await new LeagueSettingsPage(session.page, config).read();
    console.log(`  ${league.teams}-team ${league.scoring}`);

    console.log("Reading Yahoo pre-rank board...");
    const preRank = await new DraftRankingsPage(session.page, config).readPreRank();
    console.log(`  ${preRank.length} players (${preRank.filter((p) => p.adp != null).length} with ADP)`);

    const entries: BoardEntry[] = preRank.map((p) => ({
      player: { id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye },
      xRank: p.xRank,
      adp: p.adp,
      listRank: p.listRank,
    }));

    const board = buildBoard(entries, { teams: league.teams, threshold, position: positionFilter });
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
    await session.close();
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
