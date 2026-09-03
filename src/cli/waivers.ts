import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { collectIntel } from "../intel/collect.js";
import { valuePlayers, type ValueInput } from "../waivers/value.js";
import { buildAddDrops } from "../waivers/pairs.js";
import type { AddDropPair } from "../waivers/types.js";
import { hasFlag } from "./prompt.js";

/**
 * Waiver-wire add/drop recommendations (ESPN). Ranks the free-agent pool and
 * your bench by a blended value (rest-of-season + this week + waiver buzz),
 * pairs each worthwhile add with its best legal drop, and lists DEF/K streams.
 *
 * Flags:
 *   --win-now        weight this week over rest-of-season
 *   --pos <POS>      restrict to one position
 *   --limit <n>      max add/drop pairs (default 8)
 *   --llm / --no-intel   same intel controls as roster/lineup
 *   --refresh        force-refresh the intel cache
 *   --csv            also write output/waivers-<date>.csv
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const rosWeight = hasFlag("win-now") ? 0.35 : 0.7;
  const position = strFlag("pos")?.toUpperCase() ?? null;
  const limit = intFlag("limit") ?? 8;

  const provider = getProvider(config);
  try {
    console.log(`Reading ${providerLabel(config)} roster + free agents...`);
    const [{ players: roster }, fas] = await Promise.all([
      provider.getRoster(config.week),
      provider.getFreeAgents(config.week),
    ]);
    console.log(`  roster ${roster.length} · free agents ${fas.length}`);
    if (roster.length === 0) {
      console.log("Roster is empty (league not drafted?) — nothing to compare against.");
      return;
    }

    const week = config.week ?? 0;
    const intelRefs = [
      ...roster.map((p) => ({ id: p.id, name: p.name, team: p.team, position: p.position })),
      ...fas.map((f) => ({ id: f.id, name: f.name, team: f.team, position: f.position })),
    ];
    let intelById;
    let intelAsOf = "";
    if (!hasFlag("no-intel")) {
      console.log("Gathering chatter...");
      const bundle = await collectIntel(config, intelRefs, {
        scope: "waivers",
        force: hasFlag("refresh"),
        llm: hasFlag("llm"),
      });
      intelById = bundle.intel;
      intelAsOf = bundle.fetchedAt;
    }

    const settings = await provider.getLeagueSettings();

    const inputs: ValueInput[] = [
      ...fas.map((f) => ({
        id: f.id,
        position: f.position,
        weekProj: f.weekProj,
        seasonProj: f.seasonProj,
        actualSoFar: f.actualSoFar,
        pctChange: f.pctChange,
      })),
      ...roster.map((p) => ({
        id: p.id,
        position: p.position,
        weekProj: p.projectedPoints,
        seasonProj: p.seasonProjectedPoints ?? p.projectedPoints * 17,
        actualSoFar: p.pointsSoFar ?? 0,
      })),
    ];
    const values = valuePlayers(inputs, { settings, intelById, rosWeight });
    const faIds = new Set(fas.map((f) => f.id));
    const faValues = new Map([...values].filter(([id]) => faIds.has(id)));
    const rosterValues = new Map([...values].filter(([id]) => !faIds.has(id)));

    const report = buildAddDrops(fas, faValues, roster, rosterValues, {
      week,
      settings,
      rosWeight,
      limit,
      position,
      intelById,
    });
    report.intelAsOf = intelAsOf;

    printReport(report);

    if (hasFlag("csv")) {
      const dir = config.outputDir;
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, `waivers-${new Date().toISOString().slice(0, 10)}.csv`);
      await writeFile(path, toCsv(report), "utf8");
      console.log(`\nWrote ${path}`);
    }
  } finally {
    await provider.close();
  }
}

function printReport(r: ReturnType<typeof buildAddDrops>): void {
  const mode = r.rosWeight >= 0.6 ? "ROS-weighted" : "win-now";
  console.log(`\nADD / DROP  ·  week ${r.week || "(current)"}  ·  ${mode}`);
  if (r.intelAsOf) console.log(`intel as of ${r.intelAsOf}`);

  if (r.pairs.length === 0) console.log("\n  No add worth a roster move right now.");
  for (const p of r.pairs) printPair(p);

  if (r.streaming.length) {
    console.log("\nStreaming (this week only):");
    for (const p of r.streaming) printPair(p);
  }
  if (r.skippedPositions.length) {
    console.log(
      `\nNothing worth adding at ${r.skippedPositions.join(", ")} — your bench beats the pool.`,
    );
  }
}

function printPair(p: AddDropPair): void {
  const a = p.addValue;
  console.log(
    `\n  ADD   ${p.add.name} (${p.add.position}, ${p.add.team})  ` +
      `ROS ${a.rosVal} · wk ${a.weekVal} · ${p.add.pctOwned.toFixed(0)}% owned` +
      `${p.add.availability === "WAIVERS" ? " · WAIVER" : ""}`,
  );
  console.log(`        ${p.reason}`);
  if (p.drop) {
    console.log(
      `  DROP  ${p.drop.name} (${p.drop.position})  ` +
        `${p.dropValue ? `ROS ${p.dropValue.rosVal} · wk ${p.dropValue.weekVal}` : ""}`,
    );
  }
  console.log(`  → net ${p.gain >= 0 ? "+" : ""}${p.gain} value`);
}

function toCsv(r: ReturnType<typeof buildAddDrops>): string {
  const head =
    "kind,add,add_pos,add_team,add_ros,add_week,add_pct_owned,availability,drop,drop_pos,drop_ros,drop_week,gain,reason";
  const rows = [...r.pairs, ...r.streaming].map((p) =>
    [
      p.kind,
      csv(p.add.name),
      p.add.position,
      p.add.team,
      p.addValue.rosVal,
      p.addValue.weekVal,
      p.add.pctOwned.toFixed(0),
      p.add.availability,
      csv(p.drop?.name ?? ""),
      p.drop?.position ?? "",
      p.dropValue?.rosVal ?? "",
      p.dropValue?.weekVal ?? "",
      p.gain,
      csv(p.reason),
    ].join(","),
  );
  return [head, ...rows].join("\n");
}

function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function strFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
function intFlag(name: string): number | undefined {
  const v = strFlag(name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
