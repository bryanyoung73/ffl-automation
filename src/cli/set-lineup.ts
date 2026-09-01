import { loadConfig } from "../config.js";
import { openSession } from "../browser.js";
import { LineupPage } from "../pages/LineupPage.js";
import { diffLineup, optimizeLineup, slotLabel } from "../lineup/optimizer.js";
import { confirm, hasFlag } from "./prompt.js";

/**
 * Optimize this week's starting lineup from Yahoo projections, show the diff,
 * and (after confirmation) submit it.
 *
 * Flags:
 *   --dry-run   compute and print, never submit
 *   --yes       skip the confirmation prompt
 *   --pin <id>  force a player (by Yahoo id) to keep their current start slot;
 *               repeatable
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = hasFlag("dry-run");
  const skipPrompt = hasFlag("yes");
  const pinnedPlayerIds = collectPins();

  const session = await openSession(config);
  try {
    const lineup = new LineupPage(session.page, config);
    await lineup.goto();

    const { players, startingSlotCodes } = await lineup.readRoster();
    if (startingSlotCodes.length === 0) {
      throw new Error("No starting slots detected — cannot optimize. Check `npm run roster`.");
    }

    const plan = optimizeLineup(players, startingSlotCodes, { pinnedPlayerIds });
    const diff = diffLineup(players, plan);

    printPlan(plan, startingSlotCodes);
    printDiff(diff);

    if (!diff.needsSubmit) {
      console.log(
        diff.changes.length === 0
          ? "\nLineup is already optimal. Nothing to do."
          : "\nLineup is already optimal (proposed moves are cosmetic slot swaps). Nothing to submit.",
      );
      return;
    }
    if (dryRun) {
      console.log("\n--dry-run: not submitting.");
      return;
    }
    if (!skipPrompt && !(await confirm("\nSubmit these changes to Yahoo?"))) {
      console.log("Aborted.");
      return;
    }

    await lineup.applyPlan(plan, { dryRun: false });
    console.log("Lineup submitted.");
  } finally {
    await session.close();
  }
}

function collectPins(): string[] {
  const args = process.argv.slice(2);
  const pins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pin" && args[i + 1]) pins.push(args[++i]!);
  }
  return pins;
}

function printPlan(plan: ReturnType<typeof optimizeLineup>, slotCodes: string[]): void {
  console.log(`\nProposed lineup (proj ${plan.totalProjected.toFixed(1)}):`);
  console.table(
    plan.assignments.map((a) => ({
      Slot: slotLabel(a.slot),
      Player: a.player?.name ?? "— empty —",
      Proj: a.player ? a.player.projectedPoints.toFixed(1) : "",
      Status: a.player && a.player.status !== "OK" ? a.player.status : "",
    })),
  );
  if (plan.bench.length) {
    console.log("Bench:", plan.bench.map((p) => `${p.name} (${p.projectedPoints.toFixed(1)})`).join(", "));
  }
  void slotCodes;
}

function printDiff(diff: ReturnType<typeof diffLineup>): void {
  if (diff.changes.length === 0) return;
  console.log("\nChanges:");
  console.table(
    diff.changes.map((c) => ({
      Player: c.player.name,
      From: c.fromSlot,
      To: c.toSlot,
      Proj: c.player.projectedPoints.toFixed(1),
    })),
  );
  console.log(
    `Projected: ${diff.currentProjected.toFixed(1)} -> ${diff.proposedProjected.toFixed(1)} ` +
      `(${diff.delta >= 0 ? "+" : ""}${diff.delta.toFixed(1)})`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
