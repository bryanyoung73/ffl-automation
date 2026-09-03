/**
 * "Will he last?" — the chance a player is still on the board at my next pick,
 * from his ADP versus that pick number. Pure. Thresholds are module constants;
 * tune them after a live draft.
 */

/** Draft position is treated as ~Normal(adp, sigma), sigma widening with ADP —
 *  deep players go in a much wider window than early ones. */
const SIGMA_FRACTION = 0.15;
const SIGMA_FLOOR = 4;
const SIGMA_CEIL = 18;

/** prob(still available) below this ⇒ "gone"; at/above SAFE_ABOVE ⇒ "safe". */
const GONE_BELOW = 0.15;
const SAFE_ABOVE = 0.6;

export type SurvivalBucket = "gone" | "coinflip" | "safe";

export interface Survival {
  /** P(player is still on the board at `nextPickOverall`). null ⇒ no ADP. */
  prob: number | null;
  bucket: SurvivalBucket;
}

/**
 * @param adp              average draft position (overall-pick scale), or null
 * @param nextPickOverall  the overall number of my next pick
 */
export function willLast(adp: number | null, nextPickOverall: number): Survival {
  if (adp == null || !Number.isFinite(nextPickOverall)) {
    return { prob: null, bucket: "safe" };
  }
  const sigma = clamp(adp * SIGMA_FRACTION, SIGMA_FLOOR, SIGMA_CEIL);
  const prob = clamp(1 - normCdf((nextPickOverall - adp) / sigma), 0, 1);
  const bucket: SurvivalBucket =
    prob < GONE_BELOW ? "gone" : prob < SAFE_ABOVE ? "coinflip" : "safe";
  return { prob: round2(prob), bucket };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Standard normal CDF via an erf approximation (Abramowitz & Stegun 7.1.26). */
function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
