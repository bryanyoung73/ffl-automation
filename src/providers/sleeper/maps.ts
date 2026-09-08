import type { LeagueSettings, Position, SlotCode } from "../../draft/types.js";
import { POSITIONS } from "../../draft/types.js";
import type { BoardEntry } from "../../draft/board.js";
import type { DraftPick, DraftState } from "../types.js";
import { teamCode } from "../../nfl/names.js";
import type { SleeperPlayer } from "../../intel/match.js";

/* ------------------------------------------------------------------ *
 * Raw Sleeper payload shapes — only the slices we read.
 * ------------------------------------------------------------------ */

export interface SleeperLeagueRaw {
  total_rosters?: number;
  scoring_settings?: { rec?: number };
  roster_positions?: string[];
  settings?: { num_teams?: number };
  draft_id?: string;
}

export interface SleeperDraftRaw {
  draft_id?: string;
  status?: string;
  type?: string;
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
  settings?: { teams?: number; rounds?: number };
}

export interface SleeperPickRaw {
  pick_no?: number;
  round?: number;
  draft_slot?: number;
  roster_id?: number;
  player_id?: string;
  is_keeper?: boolean | null;
}

/* ------------------------------------------------------------------ *
 * Pure mappers.
 * ------------------------------------------------------------------ */

/** Sleeper roster-position code → our slot code (or a non-starter marker). */
const SLOT_BY_SLEEPER: Record<string, string | undefined> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  DEF: "DEF",
  FLEX: "W/R/T",
  WRRB_FLEX: "W/R",
  WRRB: "W/R",
  REC_FLEX: "W/T",
  WRTE_FLEX: "W/T",
  SUPER_FLEX: "OP",
  SUPERFLEX: "OP",
  BN: "BN",
  IR: "IR",
  TAXI: "TAXI",
  DL: "DL",
  LB: "LB",
  DB: "DB",
  IDP_FLEX: "IDP",
};

export function detectScoring(s: { rec?: number } | undefined): LeagueSettings["scoring"] {
  const rec = s?.rec ?? 0;
  if (rec >= 0.75) return "ppr";
  if (rec >= 0.25) return "half-ppr";
  return "standard";
}

export function mapSettings(league: SleeperLeagueRaw, draft: SleeperDraftRaw): LeagueSettings {
  const teams =
    league.total_rosters ?? league.settings?.num_teams ?? draft.settings?.teams ?? 0;
  const scoring = detectScoring(league.scoring_settings);

  const starters: LeagueSettings["starters"] = {};
  let benchSize = 0;
  for (const raw of league.roster_positions ?? []) {
    const code = SLOT_BY_SLEEPER[raw] ?? (raw === "BN" ? "BN" : undefined);
    if (!code || code === "IR" || code === "TAXI") continue;
    if (code === "BN") {
      benchSize++;
      continue;
    }
    starters[code as SlotCode] = (starters[code as SlotCode] ?? 0) + 1;
  }

  const type = (draft.type ?? "snake").toLowerCase();
  return {
    teams,
    scoring,
    starters,
    benchSize,
    draftType: type === "auction" ? "auction" : "snake",
  };
}

/** Live draft snapshot. `mySlot` / `myTeamId` come from `draft_order` +
 *  `slot_to_roster_id` when `userId` is known. */
export function mapDraftState(
  draft: SleeperDraftRaw,
  picks: readonly SleeperPickRaw[],
  userId: string | null,
): DraftState {
  const status = (draft.status ?? "").toLowerCase();
  const teams =
    draft.settings?.teams ??
    Object.keys(draft.slot_to_roster_id ?? {}).length ??
    10;

  let mySlot: number | null = null;
  if (userId && draft.draft_order && draft.draft_order[userId] != null) {
    mySlot = Number(draft.draft_order[userId]);
  }
  const myTeamId =
    mySlot != null && draft.slot_to_roster_id
      ? draft.slot_to_roster_id[String(mySlot)] ?? null
      : null;

  const mapped: DraftPick[] = (picks ?? [])
    .filter((p) => p.player_id != null && p.player_id !== "")
    .map((p) => {
      const overall = Number(p.pick_no) || 0;
      return {
        overall,
        round: Number(p.round) || 0,
        pickInRound: teams > 0 ? ((overall - 1) % teams) + 1 : (Number(p.draft_slot) || 0),
        teamId: Number(p.roster_id ?? p.draft_slot ?? 0),
        playerId: String(p.player_id),
        keeper: p.is_keeper === true,
      };
    })
    .sort((a, b) => a.overall - b.overall);

  return {
    drafted: status === "complete",
    inProgress: status === "drafting" || status === "paused",
    picks: mapped,
    mySlot,
    myTeamId,
  };
}

/* ------------------------------------------------------------------ *
 * Player universe from the /players/nfl dump.
 * ------------------------------------------------------------------ */

const BOARD_POS: ReadonlySet<string> = new Set(POSITIONS);

function sleeperName(p: SleeperPlayer): string {
  if (p.full_name) return p.full_name.trim();
  return [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
}

/**
 * The draftable player pool as `BoardEntry[]` (no ADP yet — `attachAdp` fills
 * it and the ~250 that match become the board). Offense + DEF only; IDP is a
 * later phase and FFC ADP doesn't cover it anyway.
 */
export function playerUniverse(dump: readonly SleeperPlayer[]): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (const p of dump) {
    const pos = (p.position ?? "").toUpperCase();
    if (!BOARD_POS.has(pos)) continue;
    if (p.active === false && pos !== "DEF") continue;
    const team = pos === "DEF" ? p.player_id.toUpperCase() : teamCode(p.team);
    if (!team) continue;
    const name = pos === "DEF" ? `${team} DEF` : sleeperName(p);
    if (!name) continue;
    out.push({
      player: { id: p.player_id, name, position: pos as Position, team, bye: null },
      xRank: null,
      adp: null,
      listRank: 0,
    });
  }
  return out;
}
