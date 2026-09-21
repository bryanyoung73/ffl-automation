import type { Config } from "../config.js";
import { getProvider } from "../providers/index.js";
import { intelCacheDir } from "../intel/collect.js";
import { fetchGameStatus } from "../intel/providers/vegas.js";
import { isStartingSlot } from "../lineup/optimizer.js";
import type { LineupPlan } from "../lineup/types.js";
import { appendSnapshot, readSnapshots, trackingDataDir, type Snapshot } from "./store.js";
import { selectRecommendedSnapshot, gradeWeek, summarizeSeason, type WeekGrade, type SeasonSummary } from "./grade.js";

/** Pure: a computed plan -> the snapshot shape that gets persisted. */
export function buildSnapshot(week: number, plan: LineupPlan, fetchedAt = new Date().toISOString()): Snapshot {
  return {
    week,
    fetchedAt,
    assignments: plan.assignments
      .filter((a): a is typeof a & { player: NonNullable<typeof a.player> } => a.player !== null)
      .map((a) => ({ slotCode: a.slot.code, playerId: a.player.id, playerName: a.player.name })),
  };
}

/**
 * Record what the optimizer just recommended, for later grading against what
 * actually got played (phase 2). Called every time a plan is computed — CLI
 * or dashboard, whether or not it's acted on — since the recommendation
 * existed the moment it was shown, not only if it was submitted.
 *
 * Never throws: a disk-write hiccup here must not break the primary
 * lineup-computation flow. Skips silently (with a console warning) when the
 * week isn't known — an unfiled snapshot is useless for grading anyway.
 */
export function recordSnapshot(config: Config, week: number | undefined, plan: LineupPlan): void {
  if (!week) {
    console.warn("tracking: skipped recording snapshot — week is unknown");
    return;
  }
  try {
    const season = config.espn?.season ?? new Date().getFullYear();
    appendSnapshot(trackingDataDir(config), season, buildSnapshot(week, plan));
  } catch (err) {
    console.warn(`tracking: failed to record snapshot — ${(err as Error).message}`);
  }
}

function groupByWeek(snapshots: readonly Snapshot[]): Map<number, Snapshot[]> {
  const byWeek = new Map<number, Snapshot[]>();
  for (const s of snapshots) {
    const list = byWeek.get(s.week);
    if (list) list.push(s);
    else byWeek.set(s.week, [s]);
  }
  return byWeek;
}

export interface SeasonReport {
  summary: SeasonSummary;
  /** Weeks with recorded snapshots that couldn't be graded yet, and why —
   *  e.g. the week's games aren't all final, or no snapshot was recorded
   *  before that week's first lock. */
  skipped: { week: number; reason: string }[];
}

/**
 * Build the season-to-date grading report: every week with recorded
 * snapshots, graded once (and only once) that week's real results are all
 * final. ESPN only — mirrors `getWeekResult`'s own restriction.
 */
export async function buildSeasonReport(config: Config): Promise<SeasonReport> {
  const season = config.espn?.season ?? new Date().getFullYear();
  const byWeek = groupByWeek(readSnapshots(trackingDataDir(config), season));
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);

  const grades: WeekGrade[] = [];
  const skipped: { week: number; reason: string }[] = [];
  if (weeks.length === 0) return { summary: summarizeSeason([]), skipped };

  const provider = getProvider(config);
  try {
    for (const week of weeks) {
      const weekSnapshots = byWeek.get(week)!;
      let actual;
      try {
        actual = await provider.getWeekResult(week);
      } catch (err) {
        skipped.push({ week, reason: (err as Error).message });
        continue;
      }

      const teamById = new Map(actual.players.map((p) => [p.id, p.team]));
      const gameStatus = await fetchGameStatus(intelCacheDir(config), season, week);

      const actualStarterTeams = actual.players
        .filter((p) => isStartingSlot(p.currentSlot))
        .map((p) => p.team);
      const allComplete = actualStarterTeams.every((team) => gameStatus.get(team)?.completed === true);
      if (!allComplete) {
        skipped.push({ week, reason: "week isn't fully complete yet" });
        continue;
      }

      // Union of every player who ever appeared in a snapshot this week,
      // to find that week's true first lock regardless of which specific
      // snapshot ends up graded.
      const everyPlayerId = new Set(weekSnapshots.flatMap((s) => s.assignments.map((a) => a.playerId)));
      const kickoffs = [...everyPlayerId]
        .map((id) => gameStatus.get(teamById.get(id) ?? "")?.kickoff)
        .filter((k): k is string => !!k);
      if (kickoffs.length === 0) {
        skipped.push({ week, reason: "no kickoff-time data available for this week" });
        continue;
      }
      const firstLockAt = kickoffs.reduce((min, k) => (k < min ? k : min));

      const recommended = selectRecommendedSnapshot(weekSnapshots, firstLockAt);
      if (!recommended) {
        skipped.push({ week, reason: "no recommendation was recorded before this week's first lock" });
        continue;
      }

      grades.push(gradeWeek(recommended, actual.players));
    }
  } finally {
    await provider.close();
  }

  return { summary: summarizeSeason(grades), skipped };
}

function fmt1(n: number): string {
  return n.toFixed(1);
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmt1(n)}`;
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function renderWeek(w: WeekGrade): string {
  const verdict =
    w.delta > 0 ? "you beat it" : w.delta < 0 ? "recommendation would have won" : "tied";
  const lines = [
    `Week ${w.week} — you scored ${fmt1(w.actualTotal)}, recommendation would have scored ` +
      `${fmt1(w.recommendedTotal)} (${signed(w.delta)}, ${verdict})`,
    `  Agreement: ${w.agreementCount}/${w.recommendedCount} players (${pct(w.agreementRate)})`,
  ];
  if (w.onlyActual.length) {
    lines.push("  You played instead of the recommendation:");
    for (const p of w.onlyActual) lines.push(`    + ${p.name} (${fmt1(p.points)} pts)`);
  }
  if (w.onlyRecommended.length) {
    lines.push("  Recommendation wanted instead of what you played:");
    for (const p of w.onlyRecommended) lines.push(`    - ${p.name} (${fmt1(p.points)} pts)`);
  }
  return lines.join("\n");
}

/** Pure: a SeasonReport -> printable text. See src/cli/track-review.ts. */
export function renderSeasonReport(report: SeasonReport): string {
  const { summary, skipped } = report;
  const lines = ["Recommendation tracking — season to date", ""];

  if (summary.weeks.length === 0) {
    lines.push("No weeks are gradable yet.");
  } else {
    for (const w of summary.weeks) lines.push(renderWeek(w), "");
    lines.push(
      `Season: ${summary.weeks.length} week${summary.weeks.length === 1 ? "" : "s"} graded`,
      `  Recommendation would have scored more in ${summary.weeksRecommendationWasBetter} week(s)`,
      `  What you played scored more in ${summary.weeksActualWasBetter} week(s)`,
      `  Tied in ${summary.weeksTied} week(s)`,
      `  Avg agreement: ${pct(summary.avgAgreementRate)}`,
      `  Avg delta: ${signed(summary.avgDelta)} pts/week`,
    );
  }

  if (skipped.length) {
    lines.push("", "Not graded yet:");
    for (const s of skipped) lines.push(`  Week ${s.week}: ${s.reason}`);
  }

  return lines.join("\n");
}
