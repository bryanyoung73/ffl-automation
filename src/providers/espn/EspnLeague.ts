import type { Config, EspnConfig } from "../../config.js";
import type { BoardEntry } from "../../draft/board.js";
import type { LeagueSettings, Position, SlotCode } from "../../draft/types.js";
import type { LineupPlan, Player } from "../../lineup/types.js";
import type { LeagueProvider, RosterReadResult } from "../types.js";
import { EspnClient } from "./client.js";
import {
  derivePosition,
  detectScoring,
  eligibleSlotCodes,
  injuryStatus,
  proTeamAbbr,
  rankTypeForScoring,
  slotCode,
  draftBoardFilter,
  weeklyProjectedPoints,
  type ScoringKind,
} from "./maps.js";

/* ------------------------------------------------------------------ *
 * Loose shapes for the slices of ESPN's payloads we actually read.
 * ------------------------------------------------------------------ */

interface EspnPlayer {
  id?: number;
  fullName?: string;
  defaultPositionId?: number;
  proTeamId?: number;
  byeWeek?: number;
  eligibleSlots?: number[];
  injuryStatus?: string;
  ownership?: { averageDraftPosition?: number };
  draftRanksByRankType?: Record<string, { rank?: number } | undefined>;
  stats?: Array<{
    statSourceId?: number;
    statSplitTypeId?: number;
    scoringPeriodId?: number;
    appliedTotal?: number;
  }>;
}

interface PlayerPoolEntry {
  id?: number;
  player?: EspnPlayer;
}

interface RosterEntry {
  playerId?: number;
  lineupSlotId?: number;
  playerPoolEntry?: PlayerPoolEntry;
}

interface EspnTeam {
  id?: number;
  roster?: { entries?: RosterEntry[] };
}

interface EspnSettings {
  size?: number;
  rosterSettings?: { lineupSlotCounts?: Record<string, number> };
  scoringSettings?: { scoringItems?: Array<{ statId: number; points?: number; pointsOverrides?: Record<string, number> }> };
  draftSettings?: { type?: string };
}

interface LeagueResponse {
  scoringPeriodId?: number;
  settings?: EspnSettings;
  teams?: EspnTeam[];
  players?: PlayerPoolEntry[];
}

/* ------------------------------------------------------------------ *
 * Pure mappers — fed straight from fixtures in tests.
 * ------------------------------------------------------------------ */

/** Slot ids that are a real starting slot, in the order we present them
 *  (offense, flex, K/DEF, then IDP). */
const STARTER_ORDER: ReadonlyArray<number> = [
  0, 1, 2, 4, 6, 3, 5, 23, 7, 17, 16, 15, 10, 8, 9, 11, 12, 13, 14, 19, 18,
];

export function mapSettings(raw: LeagueResponse): LeagueSettings {
  const s = raw.settings ?? {};
  const counts = s.rosterSettings?.lineupSlotCounts ?? {};
  const scoring = detectScoring(s.scoringSettings?.scoringItems);

  const starters: LeagueSettings["starters"] = {};
  for (const slotId of STARTER_ORDER) {
    const n = counts[String(slotId)] ?? 0;
    if (n <= 0) continue;
    const code = slotCode(slotId);
    if (code === "BN" || code === "IR") continue;
    starters[code as SlotCode] = (starters[code as SlotCode] ?? 0) + n;
  }

  return {
    teams: s.size ?? raw.teams?.length ?? 0,
    scoring,
    starters,
    benchSize: counts["20"] ?? 0,
    draftType: /auction/i.test(s.draftSettings?.type ?? "") ? "auction" : "snake",
  };
}

/** Flat list of starting slot codes to fill, e.g. ["QB","RB","RB","WR","WR","W/R/T","TE","K","DEF"]. */
export function startingSlotCodes(raw: LeagueResponse): string[] {
  const counts = raw.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const out: string[] = [];
  for (const slotId of STARTER_ORDER) {
    const n = counts[String(slotId)] ?? 0;
    const code = slotCode(slotId);
    if (code === "BN" || code === "IR") continue;
    for (let i = 0; i < n; i++) out.push(code);
  }
  return out;
}

export function mapRosterEntry(entry: RosterEntry, week: number): Player {
  const p = entry.playerPoolEntry?.player ?? {};
  const id = String(entry.playerId ?? p.id ?? "");
  return {
    id: id || `${p.fullName ?? "unknown"}`,
    name: (p.fullName ?? "").trim(),
    team: proTeamAbbr(p.proTeamId),
    position: derivePosition(p.eligibleSlots, p.defaultPositionId),
    eligibleSlots: eligibleSlotCodes(p.eligibleSlots),
    projectedPoints: weeklyProjectedPoints(p.stats, week),
    status: injuryStatus(p.injuryStatus),
    currentSlot: slotCode(entry.lineupSlotId),
  };
}

export function mapPlayerPoolEntry(
  entry: PlayerPoolEntry,
  index: number,
  scoring: ScoringKind,
): BoardEntry {
  const p = entry.player ?? {};
  const rankType = rankTypeForScoring(scoring);
  const adpRaw = p.ownership?.averageDraftPosition ?? 0;
  const xRank = p.draftRanksByRankType?.[rankType]?.rank ?? null;
  return {
    player: {
      id: String(p.id ?? entry.id ?? index),
      name: (p.fullName ?? "").trim(),
      position: derivePosition(p.eligibleSlots, p.defaultPositionId) as Position,
      team: proTeamAbbr(p.proTeamId),
      bye: p.byeWeek && p.byeWeek > 0 ? p.byeWeek : null,
    },
    xRank: typeof xRank === "number" && xRank > 0 ? xRank : null,
    adp: adpRaw > 0 ? adpRaw : null,
    listRank: index + 1,
  };
}

/* ------------------------------------------------------------------ *
 * Lineup writes.
 * ------------------------------------------------------------------ */

/** Representative lineup slot id for a target slot code (what a move POSTs to). */
const REP_SLOT_ID: Record<string, number> = {
  QB: 0, RB: 2, WR: 4, TE: 6, K: 17, DEF: 16, "W/R/T": 23, BN: 20, IR: 21,
  DT: 8, DE: 9, LB: 10, DL: 11, CB: 12, S: 13, DB: 14, DP: 15,
};

interface LineupItem {
  playerId: number;
  type: "LINEUP";
  fromLineupSlotId: number;
  toLineupSlotId: number;
}

/**
 * Turn an optimizer plan into ESPN transaction items: bench-outs first, then
 * promotions, so the roster is always valid mid-transaction.
 */
export function buildLineupItems(plan: LineupPlan): LineupItem[] {
  const target = new Map<string, string>(); // playerId -> target slot code
  for (const a of plan.assignments) {
    if (a.player) target.set(a.player.id, a.slot.code);
  }
  for (const p of plan.bench) target.set(p.id, "BN");

  const all: Player[] = [
    ...plan.assignments.flatMap((a) => (a.player ? [a.player] : [])),
    ...plan.bench,
  ];

  const benchOuts: LineupItem[] = [];
  const promotions: LineupItem[] = [];
  for (const p of all) {
    const from = REP_SLOT_ID[normalize(p.currentSlot)] ?? 20;
    const toCode = target.get(p.id) ?? "BN";
    const to = REP_SLOT_ID[toCode] ?? 20;
    if (from === to) continue;
    // Never auto-shuffle the IR slot: leave IR players put, and don't move
    // anyone onto IR — that's a manual roster decision.
    if (from === 21 || to === 21) continue;
    const pid = Number(p.id);
    if (!Number.isFinite(pid)) continue;
    const item: LineupItem = { playerId: pid, type: "LINEUP", fromLineupSlotId: from, toLineupSlotId: to };
    (to === 20 ? benchOuts : promotions).push(item);
  }
  return [...benchOuts, ...promotions];
}

function normalize(slot: string): string {
  const s = slot.trim().toUpperCase();
  return s === "" || s === "BENCH" ? "BN" : s;
}

/* ------------------------------------------------------------------ *
 * Provider.
 * ------------------------------------------------------------------ */

export class EspnLeague implements LeagueProvider {
  private readonly client: EspnClient;
  private readonly espn: EspnConfig;
  private readonly week: number | undefined;

  constructor(config: Config) {
    if (!config.espn) {
      throw new Error("EspnLeague requires PROVIDER=espn config (missing ESPN_* env vars).");
    }
    this.espn = config.espn;
    this.week = config.week;
    this.client = new EspnClient(config.espn);
  }

  async getLeagueSettings(): Promise<LeagueSettings> {
    const raw = await this.client.get<LeagueResponse>(["mSettings"]);
    return mapSettings(raw);
  }

  async getDraftBoard(): Promise<BoardEntry[]> {
    const settingsRaw = await this.client.get<LeagueResponse>(["mSettings"]);
    const scoring = detectScoring(settingsRaw.settings?.scoringSettings?.scoringItems);
    const raw = await this.client.get<LeagueResponse>(["kona_player_info"], {
      filter: draftBoardFilter(rankTypeForScoring(scoring)),
    });
    const players = raw.players ?? [];
    return players.map((e, i) => mapPlayerPoolEntry(e, i, scoring));
  }

  async getRoster(week?: number): Promise<RosterReadResult> {
    const raw = await this.client.get<LeagueResponse>(["mRoster", "mSettings"], {
      params: { forTeamId: this.espn.teamId },
    });
    const targetWeek = week ?? this.week ?? raw.scoringPeriodId ?? 1;
    const team = (raw.teams ?? []).find((t) => t.id === this.espn.teamId);
    if (!team) {
      throw new Error(
        `ESPN league has no team id ${this.espn.teamId}. Check ESPN_TEAM_ID in .env.`,
      );
    }
    const entries = team.roster?.entries ?? [];
    const players = entries.map((e) => mapRosterEntry(e, targetWeek));
    return { players, startingSlotCodes: startingSlotCodes(raw) };
  }

  async applyLineup(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void> {
    const items = buildLineupItems(plan);
    if (opts.dryRun || items.length === 0) return;

    const week = this.week ?? (await this.currentScoringPeriod());
    await this.client.post("transactions/", {
      isLeagueManager: false,
      teamId: this.espn.teamId,
      type: "ROSTER",
      memberId: this.espn.swid,
      scoringPeriodId: week,
      executionType: "EXECUTE",
      items,
    });
  }

  async close(): Promise<void> {
    /* stateless HTTP client — nothing to release. */
  }

  private async currentScoringPeriod(): Promise<number> {
    const raw = await this.client.get<LeagueResponse>(["mSettings"]);
    return raw.scoringPeriodId ?? 1;
  }
}
