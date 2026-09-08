import type { Config } from "../config.js";
import type { LeagueProvider } from "./types.js";
import { YahooLeague } from "./yahoo/YahooLeague.js";
import { EspnLeague } from "./espn/EspnLeague.js";
import { SleeperLeague } from "./sleeper/SleeperLeague.js";

export type { LeagueProvider, RosterReadResult } from "./types.js";

/** Human-facing name for the active provider (report headers, prompts). */
export function providerLabel(config: Config): string {
  switch (config.provider) {
    case "espn":
      return "ESPN";
    case "sleeper":
      return "Sleeper";
    default:
      return "Yahoo";
  }
}

export function getProvider(config: Config): LeagueProvider {
  switch (config.provider) {
    case "espn":
      return new EspnLeague(config);
    case "sleeper":
      return new SleeperLeague(config);
    case "yahoo":
      return new YahooLeague(config);
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}
