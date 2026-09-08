import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getProvider, providerLabel } from "../providers/index.js";
import { assembleBoard } from "../draft/assemble.js";
import { computeAdvice } from "../draft/live/assistant.js";
import type { DraftAdvice, Rec } from "../draft/live/types.js";
import { buildEvent, buildFinal, buildMeta } from "../draft/live/record.js";
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
 *   --record         append a JSONL draft log to output/ (default on; off for
 *                    --once); --no-record to disable. Feed it to draft:review.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.provider === "yahoo") {
    console.error(
      "`npm run draft` needs PROVIDER=espn or PROVIDER=sleeper — Yahoo drafts run off-platform.",
    );
    process.exit(1);
  }

  const once = hasFlag("once");
  const intervalMs = Math.max(2, intFlag("interval") ?? 5) * 1000;
  const top = intFlag("top") ?? 6;
  let slot = intFlag("slot") ?? null;
  const slotFromFlag = slot != null;
  let myTeamId = config.espn?.teamId ?? 0;
  const leagueId = config.espn?.leagueId ?? config.sleeper?.leagueId ?? "league";
  const record = hasFlag("no-record") ? false : hasFlag("record") || !once;

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

    let logPath: string | null = null;
    let logLines = 0;
    if (record) {
      mkdirSync(config.outputDir, { recursive: true });
      logPath = resolve(
        config.outputDir,
        `draft-log-${leagueId}-${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      appendLine(logPath, buildMeta({
        leagueId,
        teamId: myTeamId,
        settings: league,
        board,
        slot,
      }));
      logLines++;
      console.log(`recording → ${logPath}`);
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
        // Sleeper knows my slot / team id up front — prefer it over --slot/config.
        if (!slotFromFlag && state.mySlot != null) slot = state.mySlot;
        if (state.myTeamId != null) myTeamId = state.myTeamId;
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
        const prevCount = Math.max(0, lastCount);
        lastCount = state.picks.length;
        const advice = computeAdvice({ board, state, myTeamId, mySlot: slot, settings: league, top });
        render(advice, { clear: !once, intelAsOf });
        if (logPath) {
          appendLine(logPath, buildEvent(prevCount, state, board, advice, myTeamId));
          logLines++;
        }
        if (state.drafted) {
          if (logPath) {
            appendLine(logPath, buildFinal(state, board, myTeamId));
            logLines++;
          }
          console.log("\nDraft complete.");
          break;
        }
      }

      if (once) break;
      await sleep(intervalMs, (w) => (wake = w));
    }

    if (logPath) console.log(`\nrecorded ${logLines} lines → ${logPath}`);
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
    console.log("\nPick now   (wait N = VOR lost at this position if you pass now)");
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
  const vona = rec.vona != null && rec.vona > 0 ? `wait ${rec.vona}` : "";
  console.log(
    `  ${String(n)}. ${rec.player.name.padEnd(22)} ${rec.player.position.padEnd(3)} ` +
      `${rec.player.team.padEnd(4)} ${adp.padEnd(8)} ${vor.padEnd(10)} ${vona.padEnd(9)}`,
  );
  const volatile = rec.rankStd != null && rec.rankStd >= 6;
  const range =
    rec.ceilRank != null && rec.floorRank != null
      ? `  ·  ceil/floor ${rec.ceilRank}-${rec.floorRank}` +
        `${rec.rankStd != null ? ` (σ${rec.rankStd})` : ""}${volatile ? " BOOM/BUST" : ""}`
      : "";
  const tail = rec.vona != null && rec.vona > 0 && rec.vonaNext ? `  (vs ${rec.vonaNext} next pick)` : "";
  console.log(`     ${rec.reasons.join("  -  ")}${range}${tail}`);
}

/* ------------------------------------------------------------------ utils --- */

function sleep(ms: number, register: (wake: () => void) => void): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    register(() => {
      clearTimeout(t);
      res();
    });
  });
}

function appendLine(path: string, obj: unknown): void {
  appendFileSync(path, `${JSON.stringify(obj)}\n`, "utf8");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
