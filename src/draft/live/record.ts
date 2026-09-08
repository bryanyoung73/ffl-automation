import type { Board, BoardRow } from "../board.js";
import type { LeagueSettings, Position } from "../types.js";
import type { DraftPick, DraftState } from "../../providers/types.js";
import type { Cliff, DraftAdvice, Run } from "./types.js";
import type { SurvivalBucket } from "./survival.js";
import { SURVIVAL_CONSTANTS } from "./survival.js";
import { CLIFF_CONSTANTS } from "./context.js";
import { SCORE_CONSTANTS } from "./assistant.js";

/**
 * Draft log: `npm run draft --record` appends these as JSONL, one meta line
 * then one event per recompute then a final line. `npm run draft:review` reads
 * them back for `calibrate.ts`. Pure builders here; the CLI does the file I/O.
 */

export interface RecordedConstants {
  survival: typeof SURVIVAL_CONSTANTS;
  cliff: typeof CLIFF_CONSTANTS;
  score: typeof SCORE_CONSTANTS;
}

export interface DraftLogMeta {
  kind: "meta";
  at: string;
  version: 1;
  leagueId: string;
  teamId: number;
  teams: number;
  scoring: string;
  /** starters + bench — the snake round count. */
  rounds: number;
  starters: Record<string, number>;
  boardSize: number;
  /** Board rows joined to FantasyPros ECR. */
  ecrMatched: number;
  /** `--slot` passed at startup; may be null (auto-detected later, in events). */
  slot: number | null;
  constants: RecordedConstants;
}

export interface LandedPick {
  overall: number;
  round: number;
  teamId: number;
  playerId: string;
  name: string;
  /** null when the player is deeper than the board. */
  position: Position | null;
  adp: number | null;
  ecrRank: number | null;
  ecrTier: number | null;
  vor: number | null;
  vorRank: number | null;
  /** `overall - adp` — the survival-model calibration target. */
  adpError: number | null;
  mine: boolean;
}

export interface RecSnapshot {
  playerId: string;
  name: string;
  position: Position;
  score: number;
  adp: number | null;
  survivalProb: number | null;
  survivalBucket: SurvivalBucket;
  vona: number | null;
  ceilRank: number | null;
  floorRank: number | null;
  rankStd: number | null;
}

export interface AdviceSnapshot {
  onClock: boolean;
  overall: number;
  label: string;
  myNextOverall: number | null;
  picksUntilNext: number | null;
  slot: number | null;
  recommendations: RecSnapshot[];
  cliffs: Cliff[];
  runs: Run[];
}

export interface DraftLogEvent {
  kind: "event";
  at: string;
  /** state.picks.length after this event. */
  pickCount: number;
  /** Picks since the previous event — usually 1, more if polling lagged. */
  landed: LandedPick[];
  advice: AdviceSnapshot;
}

export interface DraftLogFinal {
  kind: "final";
  at: string;
  totalPicks: number;
  myRoster: Array<{ overall: number; playerId: string; name: string; position: Position | null }>;
}

export type DraftLogLine = DraftLogMeta | DraftLogEvent | DraftLogFinal;

/* ------------------------------------------------------------------ builders */

export function totalRounds(s: LeagueSettings): number {
  return Object.values(s.starters).reduce((a, b) => a + (b ?? 0), 0) + s.benchSize;
}

export function buildMeta(args: {
  leagueId: string;
  teamId: number;
  settings: LeagueSettings;
  board: Board;
  slot: number | null;
  now?: Date;
}): DraftLogMeta {
  const { settings, board } = args;
  return {
    kind: "meta",
    at: (args.now ?? new Date()).toISOString(),
    version: 1,
    leagueId: args.leagueId,
    teamId: args.teamId,
    teams: settings.teams,
    scoring: settings.scoring,
    rounds: totalRounds(settings),
    starters: Object.fromEntries(
      Object.entries(settings.starters).map(([k, v]) => [k, v ?? 0]),
    ),
    boardSize: board.rows.length,
    ecrMatched: board.rows.filter((r) => r.ecrRank != null).length,
    slot: args.slot,
    constants: {
      survival: SURVIVAL_CONSTANTS,
      cliff: CLIFF_CONSTANTS,
      score: SCORE_CONSTANTS,
    },
  };
}

/**
 * One event: the picks made since `prevPickCount`, joined to the board, plus a
 * trimmed snapshot of the advice shown. `state.picks` is assumed append-only
 * (it is, from `mapDraftState`), so `slice(prevPickCount)` is the delta.
 */
export function buildEvent(
  prevPickCount: number,
  state: DraftState,
  board: Board,
  advice: DraftAdvice,
  myTeamId: number,
  now?: Date,
): DraftLogEvent {
  const byId = new Map(board.rows.map((r) => [r.player.id, r]));
  const landed = state.picks
    .slice(Math.max(0, prevPickCount))
    .map((p) => toLanded(p, byId.get(p.playerId), myTeamId));
  return {
    kind: "event",
    at: (now ?? new Date()).toISOString(),
    pickCount: state.picks.length,
    landed,
    advice: snapshotAdvice(advice),
  };
}

export function buildFinal(
  state: DraftState,
  board: Board,
  myTeamId: number,
  now?: Date,
): DraftLogFinal {
  const byId = new Map(board.rows.map((r) => [r.player.id, r]));
  return {
    kind: "final",
    at: (now ?? new Date()).toISOString(),
    totalPicks: state.picks.length,
    myRoster: state.picks
      .filter((p) => p.teamId === myTeamId)
      .map((p) => ({
        overall: p.overall,
        playerId: p.playerId,
        name: byId.get(p.playerId)?.player.name ?? p.playerId,
        position: byId.get(p.playerId)?.player.position ?? null,
      })),
  };
}

/* ------------------------------------------------------------------ helpers - */

function toLanded(pick: DraftPick, row: BoardRow | undefined, myTeamId: number): LandedPick {
  const adp = row?.adp ?? null;
  return {
    overall: pick.overall,
    round: pick.round,
    teamId: pick.teamId,
    playerId: pick.playerId,
    name: row?.player.name ?? pick.playerId,
    position: row?.player.position ?? null,
    adp,
    ecrRank: row?.ecrRank ?? null,
    ecrTier: row?.ecrTier ?? null,
    vor: row?.vor ?? null,
    vorRank: row?.vorRank ?? null,
    adpError: adp != null ? pick.overall - adp : null,
    mine: pick.teamId === myTeamId,
  };
}

function snapshotAdvice(a: DraftAdvice): AdviceSnapshot {
  return {
    onClock: a.onClock,
    overall: a.overall,
    label: a.label,
    myNextOverall: a.myNextOverall,
    picksUntilNext: a.picksUntilNext,
    slot: a.slot,
    recommendations: a.recommendations.map((r) => ({
      playerId: r.player.id,
      name: r.player.name,
      position: r.player.position,
      score: r.score,
      adp: r.adp,
      survivalProb: r.survival.prob,
      survivalBucket: r.survival.bucket,
      vona: r.vona,
      ceilRank: r.ceilRank,
      floorRank: r.floorRank,
      rankStd: r.rankStd,
    })),
    cliffs: a.cliffs,
    runs: a.runs,
  };
}
