import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { assembleBoard } from "../draft/assemble.js";
import { computeAdvice } from "../draft/live/assistant.js";
import type { DraftAdvice, Rec } from "../draft/live/types.js";
import { hasFlag, intFlag } from "./prompt.js";

/**
 * Live draft assistant (ESPN). Assembles the board once, then polls the draft
 * and re-renders a ranked, need-adjusted pick list as picks come off. Read-only.
 *
 * Flags:
 *   --slot <n>       my draft position (else auto-detected from my round-1 pick)
 *   --interval <s>   poll seconds (default 5, min 2)
 *   --top <n>        recommendations to show (default 6)
 *   --once           print advice once and exit (slow drafts / testing)
 *   --no-ecr         skip FantasyPros ECR;  --no-intel skip chatter;  --llm digest
 *   --refresh        force-refresh the ECR + intel caches
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.provider !== "espn" || !config.espn) {
    console.error(
      "`npm run draft` is ESPN-only — Yahoo drafts run off-platform. Set PROVIDER=espn in .env.",
    );
    process.exit(1);
  }

  const once = hasFlag("once");
  const intervalMs = Math.max(2, intFlag("interval") ?? 5) * 1000;
  const top = intFlag("top") ?? 6;
  let slot = intFlag("slot") ?? null;
  const myTeamId = config.espn.teamId;

  const provider = getProvider(config);

  let stopped = false;
  let wake: (() => void) | null = null;
  const onSigint = (): void => {
    stopped = true;
    wake?.();
  };
  process.on("SIGINT", onSigint);

  try {
    console.log("Assembling the board (one-time)...");
    const { board, league, intelAsOf } = await assembleBoard(config, provider, {
      sourceLabel: providerLabel(config),
      noEcr: hasFlag("no-ecr"),
      noIntel: hasFlag("no-intel"),
      llm: hasFlag("llm"),
      refresh: hasFlag("refresh"),
      log: (m) => console.log(m),
    });

    if (slot != null && (slot < 1 || slot > league.teams)) {
      console.log(`  --slot ${slot} is outside 1..${league.teams}; ignoring (will auto-detect).`);
      slot = null;
    }

    console.log(
      `\nBoard ready — ${board.rows.length} players. ` +
        `${once ? "One-shot." : "Watching the draft; Ctrl+C to stop."}\n`,
    );

    let lastCount = -1;
    let backoffMs = intervalMs;

    while (!stopped) {
      let state;
      try {
        state = await provider.getDraftState();
        backoffMs = intervalMs;
      } catch (err) {
        const secs = Math.round(backoffMs / 1000);
        console.error(
          `  poll failed: ${err instanceof Error ? err.message : err} — retrying in ${secs}s`,
        );
        await sleep(backoffMs, (w) => (wake = w));
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }

      if (once || state.picks.length !== lastCount) {
        lastCount = state.picks.length;
        const advice = computeAdvice({ board, state, myTeamId, mySlot: slot, settings: league, top });
        render(advice, { clear: !once, intelAsOf });
        if (state.drafted) {
          console.log("\nDraft complete.");
          break;
        }
      }

      if (once) break;
      await sleep(intervalMs, (w) => (wake = w));
    }
  } finally {
    process.off("SIGINT", onSigint);
    await provider.close();
  }
}

/* ------------------------------------------------------------------ render -- */

function render(a: DraftAdvice, opts: { clear: boolean; intelAsOf: string }): void {
  if (opts.clear) console.clear();

  const bits = [`pick ${a.label} (overall ${a.overall})`];
  if (a.myNextOverall != null) bits.push(`your next: overall ${a.myNextOverall} (+${a.picksUntilNext})`);
  else if (a.slot == null) bits.push("slot unknown (pass --slot for turn math)");
  bits.push(`${Math.round(a.pctComplete * 100)}% done`);
  console.log(`DRAFT  ${bits.join("   ")}${a.onClock ? "   >>> ON THE CLOCK <<<" : ""}`);

  console.log("\nYour roster");
  for (const s of a.myRoster) {
    console.log(`  ${s.position.padEnd(4)} ${s.players.join(", ") || "-"}`);
  }

  if (a.recommendations.length) {
    console.log("\nPick now");
    a.recommendations.forEach((rec, i) => printRec(rec, i + 1));
  }

  if (a.cliffs.length) {
    console.log("\nTier cliffs");
    for (const c of a.cliffs) {
      const unit = c.metric === "vor" ? "pt" : "slot";
      console.log(`  ${c.position.padEnd(3)} ${c.remaining} left (${c.players.join(", ")}) then -${c.drop} ${unit}`);
    }
  }

  if (a.runs.length) {
    console.log("\nRuns");
    for (const r of a.runs) {
      console.log(`  ${r.position.padEnd(3)} ${r.count} of the last ${r.window} picks`);
    }
  }

  if (opts.intelAsOf) console.log(`\nintel as of ${opts.intelAsOf}`);
}

function printRec(rec: Rec, n: number): void {
  const adp = rec.adp != null ? `ADP ${Math.round(rec.adp)}` : "";
  const vor = rec.vor != null ? `VOR ${rec.vor >= 0 ? "+" : ""}${rec.vor}` : "";
  console.log(
    `  ${String(n)}. ${rec.player.name.padEnd(22)} ${rec.player.position.padEnd(3)} ` +
      `${rec.player.team.padEnd(4)} ${adp.padEnd(8)} ${vor.padEnd(10)}`,
  );
  console.log(`     ${rec.reasons.join("  -  ")}`);
}

/* ------------------------------------------------------------------ utils --- */

function sleep(ms: number, register: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    register(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
