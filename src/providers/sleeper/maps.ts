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
  league_id?: string | null;
  status?: string;
  type?: string;
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
  /** teams / rounds / slots_qb / slots_flex / slots_bn / … */
  settings?: Record<string, number | undefined>;
  metadata?: { scoring_type?: string; name?: string };
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

/** Sleeper `metadata.scoring_type` → our scoring. */
const SCORING_BY_TYPE: Record<string, LeagueSettings["scoring"]> = {
  ppr: "ppr",
  half_ppr: "half-ppr",
  std: "standard",
  "2qb": "ppr",
};

/** Draft-object slot key → our slot code (mock drafts carry `slots_*` counts
 *  in `settings` instead of a `roster_positions` array). */
const SLOT_KEY_BY_DRAFT: Record<string, string> = {
  slots_qb: "QB",
  slots_rb: "RB",
  slots_wr: "WR",
  slots_te: "TE",
  slots_k: "K",
  slots_def: "DEF",
  slots_flex: "W/R/T",
  slots_super_flex: "OP",
  slots_wrrb_flex: "W/R",
  slots_rec_flex: "W/T",
  slots_wrte_flex: "W/T",
  slots_idp_flex: "IDP",
  slots_dl: "DL",
  slots_lb: "LB",
  slots_db: "DB",
};

/**
 * Settings from the draft object alone — for a mock draft (no league) or as a
 * fallback. Roster shape comes from `settings.slots_*`, scoring from
 * `metadata.scoring_type` (default ppr, the Sleeper mock default).
 */
export function mapSettingsFromDraft(draft: SleeperDraftRaw): LeagueSettings {
  const s = draft.settings ?? {};
  const starters: LeagueSettings["starters"] = {};
  let starterCount = 0;
  for (const [key, code] of Object.entries(SLOT_KEY_BY_DRAFT)) {
    const n = s[key] ?? 0;
    if (n > 0) {
      starters[code as SlotCode] = (starters[code as SlotCode] ?? 0) + n;
      starterCount += n;
    }
  }
  const type = (draft.type ?? "snake").toLowerCase();
  // Mock drafts often omit `slots_bn` — bench is then rounds minus starters, so
  // `totalRounds()` still lines up with the real draft length.
  const rounds = Number(s.rounds) || 0;
  const benchSize = Number(s.slots_bn) || Math.max(0, rounds - starterCount);
  return {
    teams: Number(s.teams) || 0,
    scoring: SCORING_BY_TYPE[(draft.metadata?.scoring_type ?? "").toLowerCase()] ?? "ppr",
    starters,
    benchSize,
    draftType: type === "auction" ? "auction" : "snake",
  };
}

export function mapSettings(
  league: SleeperLeagueRaw | null,
  draft: SleeperDraftRaw,
): LeagueSettings {
  if (!league || !league.roster_positions?.length) return mapSettingsFromDraft(draft);

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
