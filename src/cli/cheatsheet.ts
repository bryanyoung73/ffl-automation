import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { openSession } from "../browser.js";
import { LeagueSettingsPage } from "../pages/LeagueSettingsPage.js";
import { DraftRankingsPage, type PreRankEntry } from "../pages/DraftRankingsPage.js";
import { ProjectionsPage } from "../pages/ProjectionsPage.js";
import { computeVor } from "../draft/vor.js";
import { findOverrides } from "../draft/diff.js";
import { buildCheatSheet, renderReport } from "../draft/report.js";
import { POSITIONS, type PlayerProjection, type PlayerSignals, type Position } from "../draft/types.js";
import { hasFlag } from "./prompt.js";

/**
 * Diff Yahoo's default pre-rank against ADP + a computed VOR ranking and write an
 * override sheet to artifacts/.
 *
 * Flags:
 *   --threshold <n>   abs(rank gap) needed to flag (default: env or 10)
 *   --pos <POS>       restrict analysis to QB|RB|WR|TE|K|DEF
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const threshold = intFlag("threshold") ?? config.overrideThreshold;
  const positionFilter = posFlag();

  const session = await openSession(config);
  try {
    console.log("Reading league settings...");
    const league = await new LeagueSettingsPage(session.page, config).read();
    console.log(
      `  ${league.teams}-team ${league.scoring} ${league.draftType}; ` +
        `starters ${JSON.stringify(league.starters)}`,
    );

    console.log("Reading Yahoo default pre-rank...");
    const preRank = await new DraftRankingsPage(session.page, config).readPreRank();
    console.log(`  ${preRank.length} players`);

    console.log("Reading ADP...");
    const adp = await new DraftRankingsPage(session.page, config).readAdp();
    console.log(`  ${adp.size} players with ADP`);

    console.log("Reading season projections...");
    const projById = await new ProjectionsPage(session.page, config).read();
    console.log(`  ${projById.size} players with projections`);

    const projections: PlayerProjection[] = preRank
      .filter((p) => projById.has(p.id))
      .map((p) => ({ ...toRef(p), projectedPoints: projById.get(p.id)! }));

    const vor = computeVor(projections, league);
    const adpRank = toRankMap(adp, "asc");

    const signals: PlayerSignals[] = preRank.map((p) => ({
      player: toRef(p),
      yahooRank: p.rank,
      signals: pruneUndefined({
        adp: adpRank.get(p.id),
        vor: vor.get(p.id)?.vorRank,
      }),
    }));

    const overrides = findOverrides(signals, {
      threshold,
      position: positionFilter,
      teams: league.teams,
    });
    const sheet = buildCheatSheet({ overrides, league, threshold, positionFilter });
    const { markdown, csv, summary } = renderReport(sheet);

    const dir = resolve(config.projectRoot, "artifacts");
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

function toRef(p: PreRankEntry) {
  return { id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye };
}

/** value map -> rank map (1 = smallest value when dir="asc"). */
function toRankMap(values: Map<string, number>, dir: "asc" | "desc"): Map<string, number> {
  const sorted = [...values.entries()].sort((a, b) => (dir === "asc" ? a[1] - b[1] : b[1] - a[1]));
  const ranks = new Map<string, number>();
  sorted.forEach(([id], i) => ranks.set(id, i + 1));
  return ranks;
}

function pruneUndefined<T extends Record<string, number | undefined>>(
  obj: T,
): { [K in keyof T]?: number } {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "number") out[k] = v;
  return out as { [K in keyof T]?: number };
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

void hasFlag;

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
