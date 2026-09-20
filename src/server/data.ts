import type { Config } from "../config.js";
import { getProvider } from "../providers/index.js";
import { applyWeeklyIntel } from "../intel/weekly.js";
import { collectIntel } from "../intel/collect.js";
import { diffLineup, optimizeLineup } from "../lineup/optimizer.js";
import { attachKickoffTimes } from "../lineup/kickoff.js";
import type { LineupDiff, LineupPlan } from "../lineup/types.js";
import type { ProjectionAdjustment } from "../intel/apply.js";
import { valuePlayers, type ValueInput } from "../waivers/value.js";
import { fetchSecondarySeasonProjections } from "../waivers/secondary.js";
import { buildAddDrops } from "../waivers/pairs.js";
import type { WaiverReport } from "../waivers/types.js";

/**
 * Read-only view builders for the web dashboard. Each mirrors the exact
 * pipeline its CLI twin runs (`src/cli/set-lineup.ts`, `src/cli/waivers.ts`)
 * minus the write step and the terminal-only flags (--csv, --pos, --limit).
 */

export interface LineupView {
  provider: string;
  week: number | undefined;
  plan: LineupPlan;
  diff: LineupDiff;
  adjustments: ProjectionAdjustment[];
  fetchedAt: string;
}

export async function getLineupView(config: Config): Promise<LineupView> {
  const provider = getProvider(config);
  try {
    const { players: rawPlayers, startingSlotCodes, week: resolvedWeek } = await provider.getRoster(config.week);
    if (startingSlotCodes.length === 0) {
      throw new Error("No starting slots detected — check the roster/provider config.");
    }

    // Prefer the provider's own resolved current week over config.week (which
    // is usually unset) so the LLM digest doesn't wrongly assume preseason.
    const { players: intelPlayers, adjustments, fetchedAt } = await applyWeeklyIntel(config, rawPlayers, {
      week: resolvedWeek,
    });

    // For the optimizer's flex-slot tie-break only (see optimizer.ts) — never
    // affects projections or which players start, only labeling among ties.
    const players = await attachKickoffTimes(config, intelPlayers, resolvedWeek);

    // Mirror set-lineup.ts: a locked player (game already started) can't
    // move — pin him so the optimizer works around him instead of proposing
    // a change the provider would reject.
    const pinnedPlayerIds = players.filter((p) => p.locked).map((p) => p.id);

    const plan = optimizeLineup(players, startingSlotCodes, { pinnedPlayerIds });
    const diff = diffLineup(players, plan);

    return { provider: config.provider, week: config.week ?? resolvedWeek, plan, diff, adjustments, fetchedAt };
  } finally {
    await provider.close();
  }
}

export type WaiverView = WaiverReport | { unavailable: true; reason: string };

export async function getWaiverView(config: Config): Promise<WaiverView> {
  if (config.provider === "yahoo") {
    return {
      unavailable: true,
      reason: "Waiver analysis needs PROVIDER=espn or sleeper — Yahoo has no free-agent read.",
    };
  }

  const provider = getProvider(config);
  try {
    const [{ players: roster, week: resolvedWeek }, fas] = await Promise.all([
      provider.getRoster(config.week),
      provider.getFreeAgents(config.week),
    ]);
    if (roster.length === 0) {
      return { unavailable: true, reason: "Roster is empty (league not drafted?) — nothing to compare against." };
    }

    // Prefer the provider's own resolved current week over config.week (which
    // is usually unset) so the LLM digest doesn't wrongly assume preseason.
    const week = config.week ?? resolvedWeek ?? 0;
    const intelRefs = [
      ...roster.map((p) => ({ id: p.id, name: p.name, team: p.team, position: p.position })),
      ...fas.map((f) => ({ id: f.id, name: f.name, team: f.team, position: f.position })),
    ];
    const bundle = await collectIntel(config, intelRefs, { scope: "waivers", week });

    const settings = await provider.getLeagueSettings();
    const rosWeight = 0.7;

    // A second opinion on ROS value from Sleeper's own model — see
    // src/waivers/secondary.ts and src/cli/waivers.ts (same pipeline).
    const secondary = await fetchSecondarySeasonProjections(config, intelRefs, settings.scoring);

    const inputs: ValueInput[] = [
      ...fas.map((f) => ({
        id: f.id,
        position: f.position,
        weekProj: f.weekProj,
        seasonProj: f.seasonProj,
        actualSoFar: f.actualSoFar,
        pctChange: f.pctChange,
        secondarySeasonProj: secondary.get(f.id),
      })),
      ...roster.map((p) => ({
        id: p.id,
        position: p.position,
        weekProj: p.projectedPoints,
        seasonProj: p.seasonProjectedPoints ?? p.projectedPoints * 17,
        actualSoFar: p.pointsSoFar ?? 0,
        secondarySeasonProj: secondary.get(p.id),
      })),
    ];
    const values = valuePlayers(inputs, { settings, intelById: bundle.intel, rosWeight });
    const faIds = new Set(fas.map((f) => f.id));
    const faValues = new Map([...values].filter(([id]) => faIds.has(id)));
    const rosterValues = new Map([...values].filter(([id]) => !faIds.has(id)));

    const report = buildAddDrops(fas, faValues, roster, rosterValues, {
      week,
      settings,
      rosWeight,
      limit: 8,
      position: null,
      intelById: bundle.intel,
    });
    report.intelAsOf = bundle.fetchedAt;
    return report;
  } finally {
    await provider.close();
  }
}
