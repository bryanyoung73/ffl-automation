import {
  type Override,
  type OverrideDirection,
  type PlayerSignals,
  type Position,
  type SignalName,
} from "./types.js";

export interface DiffOptions {
  /** Minimum abs(yahooRank - consensusRank) to flag. Default 10. */
  threshold?: number;
  /** Restrict to one position. Default: all. */
  position?: Position | null;
  /** Teams in the league — sets the round-bucket size for tier crossing. */
  teams: number;
}

const SIGNAL_ORDER: readonly SignalName[] = ["adp", "vor", "ecr"];

/**
 * Compare Yahoo's default pre-rank against the available independent signals and
 * return the players worth overriding, most significant first.
 */
export function findOverrides(
  players: readonly PlayerSignals[],
  options: DiffOptions,
): Override[] {
  const threshold = options.threshold ?? 10;
  const teams = Math.max(1, options.teams);
  const tierOf = (rank: number): number => Math.max(1, Math.ceil(rank / teams));

  const overrides: Override[] = [];

  for (const entry of players) {
    if (options.position && entry.player.position !== options.position) continue;

    const values = SIGNAL_ORDER.map((name) => entry.signals[name]).filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v),
    );
    if (values.length === 0) continue;

    const consensusRank = round2(values.reduce((a, b) => a + b, 0) / values.length);
    const delta = round2(entry.yahooRank - consensusRank);
    const crossesTier = tierOf(entry.yahooRank) !== tierOf(consensusRank);

    if (Math.abs(delta) < threshold && !crossesTier) continue;

    const direction: OverrideDirection = delta > 0 ? "undervalued" : "overvalued";
    overrides.push({
      player: entry.player,
      yahooRank: entry.yahooRank,
      consensusRank,
      delta,
      direction,
      signals: { ...entry.signals },
      tier: tierOf(consensusRank),
      crossesTier,
    });
  }

  overrides.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      a.consensusRank - b.consensusRank ||
      a.player.name.localeCompare(b.player.name),
  );
  return overrides;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
