import { POSITIONS, type LeagueSettings, type Position } from "../types.js";
import type { Board, BoardRow } from "../board.js";
import type { DraftState } from "../../providers/types.js";
import { mySlots, nextPick, picksUntilNext } from "./snake.js";
import { myRoster, rosterNeeds } from "./needs.js";
import { tierCliffs, positionRuns } from "./context.js";
import { willLast, type Survival, type SurvivalBucket } from "./survival.js";
import { computeVona } from "./vona.js";
import type { Cliff, DraftAdvice, PositionNeed, Rec, RosterSlotView, Run } from "./types.js";

const DEFAULT_TOP = 6;
/** Additive nudges — small next to need-weighted value, so they only bite when
 *  the field has compressed (i.e. later in the draft, which is the point). */
const SURVIVAL_BONUS: Record<SurvivalBucket, number> = { gone: 8, coinflip: 4, safe: 0 };
const RUN_BUMP = 3;
const CLIFF_BUMP = 6;
const DEFAULT_NEED_WEIGHT = 0.3;

/** The scoring constants in force — recorded in the draft log's meta line. */
export const SCORE_CONSTANTS = Object.freeze({
  defaultTop: DEFAULT_TOP,
  survivalBonus: { ...SURVIVAL_BONUS },
  runBump: RUN_BUMP,
  cliffBump: CLIFF_BUMP,
  defaultNeedWeight: DEFAULT_NEED_WEIGHT,
});

export interface AdviceInput {
  board: Board;
  state: DraftState;
  /** My league team id (ESPN `teamId`). */
  myTeamId: number;
  /** My draft slot (1-based). Ignored once round 1 reveals it. null = unknown. */
  mySlot: number | null;
  settings: LeagueSettings;
  /** Recommendations to return. Default 6. */
  top?: number;
}

/**
 * Turn the current board + draft state into a ranked set of pick suggestions
 * for my team. Pure — the CLI calls this on every poll and re-renders.
 *
 * Score = base value (VOR, or an ECR/rank fallback) × the position's need
 * weight, plus small bumps for a player likely to be gone by my next pick, a
 * thinning tier, or a run at his position.
 */
export function computeAdvice(input: AdviceInput): DraftAdvice {
  const { board, state, myTeamId, settings } = input;
  const top = input.top ?? DEFAULT_TOP;

  const completed = state.picks.length;
  const rounds = totalRounds(settings);
  const totalPicks = settings.teams * rounds;
  const done = state.drafted || (totalPicks > 0 && completed >= totalPicks);
  const overall = done ? completed : completed + 1;

  const mineRows = myRoster(state, myTeamId, board.rows);
  const myRosterView = rosterView(mineRows);

  // Slot: round 1 is authoritative once it contains my pick; else the passed value.
  const detected =
    state.picks.find((p) => p.round === 1 && p.teamId === myTeamId)?.pickInRound ?? null;
  const slotRaw = detected ?? input.mySlot ?? null;
  const slot = slotRaw != null && slotRaw >= 1 && slotRaw <= settings.teams ? slotRaw : null;

  let myNextOverall: number | null = null;
  let untilNext: number | null = null;
  if (slot != null) {
    const mine = mySlots(slot, settings.teams, rounds);
    myNextOverall = nextPick(completed, mine);
    untilNext = picksUntilNext(completed, mine);
  }

  const shell = {
    onClock: untilNext === 0,
    overall,
    label: pickLabel(overall, settings.teams),
    myNextOverall,
    picksUntilNext: untilNext,
    pctComplete: totalPicks > 0 ? round2(completed / totalPicks) : 0,
    slot,
    myRoster: myRosterView,
  };

  if (done) {
    return { ...shell, recommendations: [], cliffs: [], runs: [] };
  }

  const taken = new Set(state.picks.map((p) => p.playerId));
  const available = board.rows.filter((r) => !taken.has(r.player.id));

  const needByPos = new Map(rosterNeeds(mineRows, settings).map((n) => [n.position, n]));
  const cliffs = tierCliffs(available, settings);
  const cliffByPos = new Map(cliffs.map((c) => [c.position, c]));
  const runs = positionRuns(state, board.rows, settings.teams);
  const runByPos = new Map(runs.map((r) => [r.position, r]));

  const scored = available.map((row) => {
    const pos = row.player.position;
    const need = needByPos.get(pos) ?? fallbackNeed(pos);
    const surv: Survival =
      myNextOverall != null
        ? willLast(row.adp, myNextOverall, row.adpStdev)
        : { prob: null, bucket: "safe" };

    const tierCliff = cliffByPos.get(pos);
    const inCliff = tierCliff?.players.includes(row.player.name) ?? false;
    const run = runByPos.get(pos);

    let score = baseValue(row) * need.weight;
    score += SURVIVAL_BONUS[surv.bucket];
    if (run) score += RUN_BUMP;
    if (inCliff) score += CLIFF_BUMP;

    return { row, need, surv, score, cliff: inCliff ? tierCliff : undefined, run };
  });
  scored.sort((a, b) => b.score - a.score);

  const recommendations: Rec[] = scored.slice(0, top).map(({ row, need, surv, score, cliff, run }) => {
    const vona = computeVona(row, available, myNextOverall);
    return {
      player: row.player,
      adp: row.adp,
      vor: row.vor,
      vorRank: row.vorRank,
      ecrPosRank: row.ecrPosRank,
      needWeight: need.weight,
      survival: surv,
      score: round1(score),
      vona: vona?.gap ?? null,
      vonaNext: vona?.nextName ?? null,
      ceilRank: row.ecrRankMin,
      floorRank: row.ecrRankMax,
      rankStd: row.ecrRankStd,
      reasons: buildReasons(row, need, surv, myNextOverall, cliff, run),
    };
  });

  return { ...shell, recommendations, cliffs, runs };
}

/* ---------------------------------------------------------------- helpers -- */

function totalRounds(s: LeagueSettings): number {
  const starters = Object.values(s.starters).reduce((a, b) => a + (b ?? 0), 0);
  return starters + s.benchSize;
}

function pickLabel(overall: number, teams: number): string {
  const round = Math.max(1, Math.ceil(overall / teams));
  const inRound = ((overall - 1) % teams) + 1;
  return `${round}.${String(inRound).padStart(2, "0")}`;
}

function fallbackNeed(position: Position): PositionNeed {
  return {
    position,
    haveStarters: 0,
    startersLeft: 0,
    flexShare: 0,
    haveBench: 0,
    weight: DEFAULT_NEED_WEIGHT,
  };
}

/** Base value on a points-ish scale: VOR when we have projections, else a
 *  gentle curve off ECR, else off the board rank. */
function baseValue(row: BoardRow): number {
  if (row.vor != null) return row.vor;
  if (row.ecrRank != null) return Math.max(0, 70 - row.ecrRank * 0.45);
  return Math.max(0, 45 - row.rank * 0.15);
}

function rosterView(mine: readonly BoardRow[]): RosterSlotView[] {
  const byPos = new Map<Position, string[]>(POSITIONS.map((p) => [p, []]));
  for (const r of mine) {
    const list = byPos.get(r.player.position);
    if (list) list.push(r.player.name);
    else byPos.set(r.player.position, [r.player.name]);
  }
  return [...byPos].map(([position, players]) => ({ position, players }));
}

function buildReasons(
  row: BoardRow,
  need: PositionNeed,
  surv: Survival,
  myNextOverall: number | null,
  cliff: Cliff | undefined,
  run: Run | undefined,
): string[] {
  const pos = row.player.position;
  const out: string[] = [];

  if (need.startersLeft > 0) out.push(`fills your ${ordinal(need.haveStarters + 1)} ${pos} slot`);
  else if (need.flexShare > 0) out.push(`FLEX-worthy ${pos}`);
  else out.push(`${pos} depth`);

  if (surv.bucket === "gone" && myNextOverall != null) {
    out.push(`won't last to ${myNextOverall} (ADP ${fmtAdp(row.adp)})`);
  } else if (surv.bucket === "coinflip" && myNextOverall != null) {
    out.push(`coin-flip to last to ${myNextOverall}`);
  }

  if (cliff) {
    const unit = cliff.metric === "vor" ? "pt" : "slot";
    out.push(
      cliff.remaining === 1
        ? `last ${pos} in this tier — ${cliff.drop}-${unit} drop after`
        : `${cliff.remaining} left in the ${pos} tier before a ${cliff.drop}-${unit} drop`,
    );
  }

  if (run) out.push(`${run.count} of the last ${run.window} picks were ${pos}`);

  const valueBits = [
    row.ecrPosRank,
    row.vor != null ? `VOR ${row.vor >= 0 ? "+" : ""}${round1(row.vor)}` : null,
  ].filter((b): b is string => !!b);
  if (valueBits.length) out.push(valueBits.join(" · "));

  if (row.intelNote) out.push(row.intelNote);

  return out.slice(0, 3);
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

function fmtAdp(adp: number | null): string {
  return adp == null ? "?" : String(Math.round(adp));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
