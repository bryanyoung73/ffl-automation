import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { diffLineup, optimizeLineup, slotLabel } from "../lineup/optimizer.js";
import { confirm, hasFlag } from "./prompt.js";
import { applyWeeklyIntel, formatAdjustments } from "../intel/weekly.js";

/**
 * Optimize this week's starting lineup from projections (nudged by chatter/news
 * intel), show the diff, and — after confirmation — submit it.
 *
 * Flags:
 *   --dry-run    compute and print, never submit
 *   --yes        skip the confirmation prompt
 *   --pin <id>   force a player to keep their current start slot; repeatable
 *   --no-intel   optimize on raw projections, no chatter adjustment
 *   --llm        use the LLM news digest (needs ANTHROPIC_API_KEY)
 *   --refresh    force-refresh the intel cache
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = hasFlag("dry-run");
  const skipPrompt = hasFlag("yes");
  const pinnedPlayerIds = collectPins();

  const provider = getProvider(config);
  const label = providerLabel(config);
  try {
    const { players: rawPlayers, startingSlotCodes } = await provider.getRoster(config.week);
    if (startingSlotCodes.length === 0) {
      throw new Error("No starting slots detected — cannot optimize. Check `npm run roster`.");
    }

    const { players, adjustments, fetchedAt, skipped } = await applyWeeklyIntel(config, rawPlayers, {
      skip: hasFlag("no-intel"),
      force: hasFlag("refresh"),
      llm: hasFlag("llm"),
    });

    // A locked player (game already started) can't move — pin him so the
    // optimizer works around him instead of proposing a change the provider
    // will reject.
    const lockedIds = players.filter((p) => p.locked).map((p) => p.id);
    if (lockedIds.length) {
      const names = players.filter((p) => p.locked).map((p) => p.name).join(", ");
      console.log(`Locked (game started, held in place): ${names}`);
      for (const id of lockedIds) if (!pinnedPlayerIds.includes(id)) pinnedPlayerIds.push(id);
    }
    if (!skipped) {
      const lines = formatAdjustments(adjustments);
      console.log(`Intel as of ${fetchedAt || "(unknown)"}:`);
      console.log(lines.length ? lines.join("\n") : "  (no notable chatter for this roster)");
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
    if (!skipPrompt && !(await confirm(`\nSubmit these changes to ${label}?`))) {
      console.log("Aborted.");
      return;
    }

    await provider.applyLineup(plan, { dryRun: false });
    console.log("Lineup submitted.");
  } finally {
    await provider.close();
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
  process.exitCode = 1; // not process.exit() — a mid-fetch abort trips libuv on Windows/tsx
});
