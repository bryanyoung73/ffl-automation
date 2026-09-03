import type { Config } from "../config.js";
import type { LeagueProvider } from "../providers/types.js";
import { buildBoard, type Board } from "./board.js";
import type { LeagueSettings, Position } from "./types.js";
import { fetchEcr, attachEcr } from "./ecr.js";
import { collectIntel, intelCacheDir } from "../intel/collect.js";
import type { PlayerIntel } from "../intel/types.js";

const silent = (): void => {};

export interface AssembleOptions {
  /** Source name for rendered headers ("ESPN" / "Yahoo"). */
  sourceLabel?: string;
  /** abs(expert rank − board rank) to flag a disagreement. */
  threshold?: number;
  /** Restrict the board to one position. */
  position?: Position | null;
  /** Reorder the board by ADP shifted by chatter impact. */
  blend?: boolean;
  /** Skip the FantasyPros ECR fetch (flag against the source's own rank). */
  noEcr?: boolean;
  /** Skip the chatter/news intel pass entirely. */
  noIntel?: boolean;
  /** Use the LLM news digest instead of keyword scoring. */
  llm?: boolean;
  /** Force-refresh the ECR + intel caches. */
  refresh?: boolean;
  /** Players (by ADP) to gather intel for. Default `league.teams * 8`. */
  intelDepth?: number;
  /** Progress sink. Default: silent. */
  log?: (msg: string) => void;
}

export interface AssembledBoard {
  league: LeagueSettings;
  /** The ordered, flagged, VOR/intel-annotated board. */
  board: Board;
  /** ISO time the intel bundle was gathered, "" when skipped. */
  intelAsOf: string;
}

/**
 * Shared board pipeline: provider draft board → FantasyPros ECR → chatter
 * intel → `buildBoard`. Used by `npm run cheatsheet` (writes it to disk) and
 * `npm run draft` (subtracts drafted players and re-ranks each poll).
 */
export async function assembleBoard(
  config: Config,
  provider: LeagueProvider,
  opts: AssembleOptions = {},
): Promise<AssembledBoard> {
  const log = opts.log ?? silent;

  log("Reading league settings...");
  const league = await provider.getLeagueSettings();
  log(`  ${league.teams}-team ${league.scoring}`);

  log(`Reading ${opts.sourceLabel ? `${opts.sourceLabel} ` : ""}draft board...`);
  let entries = await provider.getDraftBoard();
  log(
    `  ${entries.length} players (${entries.filter((p) => p.adp != null).length} with ADP)`,
  );

  if (!opts.noEcr) {
    const ecr = await fetchEcr(intelCacheDir(config), league.scoring, {
      force: opts.refresh,
    });
    if (ecr.length) {
      const res = attachEcr(entries, ecr);
      entries = res.entries;
      log(`  ${res.matched}/${entries.length} matched to FantasyPros ECR (${league.scoring})`);
    } else {
      log("  FantasyPros ECR unavailable — using the source's own rank");
    }
  }

  let intel: ReadonlyMap<string, PlayerIntel> | undefined;
  let intelAsOf = "";
  if (!opts.noIntel) {
    const depth = opts.intelDepth ?? league.teams * 8;
    const forIntel = [...entries]
      .sort((a, b) => (a.adp ?? a.xRank ?? 9999) - (b.adp ?? b.xRank ?? 9999))
      .slice(0, depth)
      .map((e) => ({
        id: e.player.id,
        name: e.player.name,
        team: e.player.team,
        position: e.player.position,
      }));
    log(`Gathering chatter for the top ${forIntel.length}...`);
    const bundle = await collectIntel(config, forIntel, {
      scope: "draft",
      force: opts.refresh,
      llm: opts.llm,
    });
    intel = bundle.intel;
    intelAsOf = bundle.fetchedAt;
    log(`  ${bundle.intel.size} players with notes`);
  }

  const withVor = entries.some((e) => (e.projectedPoints ?? 0) > 0);
  if (withVor) log("  season projections present — VOR enabled");

  const board = buildBoard(entries, {
    teams: league.teams,
    threshold: opts.threshold,
    position: opts.position ?? null,
    sourceLabel: opts.sourceLabel,
    intel,
    blend: opts.blend,
    intelAsOf,
    leagueSettings: league,
  });

  return { league, board, intelAsOf };
}
