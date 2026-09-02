/**
 * Player intel — a chatter/news signal that feeds both the draft cheat sheet
 * and week-to-week start/sit. See docs/specs/2026-09-02-player-intel.md.
 */

/** Minimal player shape both `PlayerRef` (draft) and `Player` (lineup) satisfy. */
export interface IntelPlayerRef {
  id: string;
  name: string;
  team: string;
  position: string;
}

export type Horizon = "season" | "week" | "both";

export interface IntelNote {
  /** One line, human-readable. */
  text: string;
  /** Provider name, e.g. "sleeper" | "espn-news". */
  source: string;
  url?: string;
  /** Which decision this note informs. */
  horizon: Horizon;
  /** ISO timestamp of the underlying event/report. */
  asOf: string;
}

export interface PlayerIntel {
  /** The roster/board player id this intel attaches to. */
  playerKey: string;
  notes: IntelNote[];
  /** -3 (hard fade) .. +3 (buy), for draft decisions. */
  seasonImpact: number;
  /** -3 .. +3, for this week's start/sit. */
  weekImpact: number;
  /** 0..1 — how much to trust the impact numbers. */
  confidence: number;
  /** Newest note timestamp (ISO), or "" if no dated notes. */
  asOf: string;
}

/** Cross-provider identity for one input player. */
export interface PlayerIdentity {
  id: string;
  name: string;
  team: string;
  position: string;
  sleeperId?: string;
  espnId?: string;
  yahooId?: string;
}

export interface IntelContext {
  players: readonly IntelPlayerRef[];
  week: number;
  season: number;
  /** Resolve an input player id to its cross-provider ids. */
  identity: (playerId: string) => PlayerIdentity | undefined;
  /** Absolute path to the on-disk cache dir (`.cache/`). */
  cacheDir: string;
  /** Claude model id for the LLM digest provider. */
  llmModel: string;
}

export interface IntelProvider {
  name: string;
  /** Partial intel keyed by input player id; players may be omitted. */
  collect(ctx: IntelContext): Promise<Map<string, PartialIntel>>;
}

/** What a provider contributes for one player before merge. */
export interface PartialIntel {
  notes?: IntelNote[];
  seasonImpact?: number;
  weekImpact?: number;
  confidence?: number;
}
