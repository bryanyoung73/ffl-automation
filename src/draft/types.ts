export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

export const POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Slot code as Yahoo labels it. FLEX is "W/R/T". */
export type SlotCode = Position | "W/R/T";

export interface LeagueSettings {
  teams: number;
  scoring: "standard" | "half-ppr" | "ppr";
  /** Starting slot counts, e.g. { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 }. */
  starters: Partial<Record<SlotCode, number>>;
  benchSize: number;
  draftType: "snake" | "auction";
}

export interface PlayerRef {
  /** Yahoo player id. */
  id: string;
  name: string;
  position: Position;
  team: string;
  /** NFL bye week, or null if unknown. */
  bye: number | null;
}

export interface PlayerProjection extends PlayerRef {
  projectedPoints: number;
}

export interface VorResult {
  vor: number;
  /** 1-based rank across all players by VOR, best first. */
  vorRank: number;
}

/** Signal names, each producing a per-player rank (1 = best). */
export type SignalName = "adp" | "vor" | "ecr";

export interface PlayerSignals {
  player: PlayerRef;
  /** Yahoo's default pre-rank — the ordering we're deciding whether to override. */
  yahooRank: number;
  /** Available independent signal ranks. Missing entries are simply absent. */
  signals: Partial<Record<SignalName, number>>;
}

export type OverrideDirection = "undervalued" | "overvalued";

export interface Override {
  player: PlayerRef;
  yahooRank: number;
  /** Mean of available signal ranks. */
  consensusRank: number;
  /** yahooRank - consensusRank. Positive = Yahoo ranks him too low (draft earlier). */
  delta: number;
  direction: OverrideDirection;
  signals: Partial<Record<SignalName, number>>;
  /** Snake round bucket of consensusRank: ceil(consensusRank / teams). */
  tier: number;
  /** True when yahooRank and consensusRank fall in different round buckets. */
  crossesTier: boolean;
}

export interface CheatSheet {
  generatedAt: string;
  league: LeagueSettings;
  thresholdUsed: number;
  positionFilter: Position | null;
  overrides: Override[];
  counts: { undervalued: number; overvalued: number };
  verdict: string;
}
