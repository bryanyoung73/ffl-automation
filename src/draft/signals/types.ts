import type { LeagueSettings, PlayerRef, SignalName } from "../types.js";

export interface SignalProviderContext {
  league: LeagueSettings;
  /** The player pool to rank, from Yahoo's default pre-rank. */
  players: readonly PlayerRef[];
}

export interface SignalProvider {
  name: SignalName;
  /**
   * Return a rank (1 = best) for each player this provider has an opinion on,
   * keyed by Yahoo player id. Players may be omitted.
   */
  ranks(ctx: SignalProviderContext): Promise<Map<string, number>>;
}
