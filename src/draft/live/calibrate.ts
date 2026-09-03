import type { Position } from "../types.js";
import { mySlots } from "./snake.js";
import type { DraftLogEvent, DraftLogFinal, DraftLogMeta, LandedPick } from "./record.js";

/**
 * Post-draft calibration: read a recorded draft log and report how well the
 * survival model, tier-gap constant, and recommendations held up — with
 * suggested constant values. Pure; `npm run draft:review` does the I/O.
 */

/** For a zero-mean normal, E|X| = sigma * sqrt(2/pi); invert to get sigma from
 *  a mean absolute deviation. */
const MAD_TO_SIGMA = 1 / Math.sqrt(2 / Math.PI); // ≈ 1.2533

const ADP_BINS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 12, "1-12"],
  [13, 36, "13-36"],
  [37, 72, "37-72"],
  [73, 120, "73-120"],
  [121, Infinity, "121+"],
];

export interface SigmaBin {
  range: string;
  n: number;
  meanError: number | null;
  stdev: number | null;
  /** sigma the model uses at this bin's midpoint. */
  currentSigma: number;
}

export interface ReliabilityDecile {
  range: string;
  n: number;
  predictedMean: number;
  observedLastedRate: number;
}

export interface TierGapStat {
  position: Position;
  n: number;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  currentGap: number;
}

export interface HitRate {
  picks: number;
  top1: number;
  top3: number;
  top6: number;
  detail: Array<{ overall: number; took: string; rankInList: number | null }>;
}

export interface CalibrationReport {
  events: number;
  draftedPicks: number;
  picksWithAdp: number;
  sigma: {
    bins: SigmaBin[];
    fit: { intercept: number; slope: number; r2: number } | null;
    current: { fraction: number; floor: number; ceil: number };
    suggested: { fraction: number; floor: number; ceil: number } | null;
  };
  reliability: {
    n: number;
    brier: number | null;
    deciles: ReliabilityDecile[];
    bucketCheck: {
      gone: { n: number; lastedRate: number | null };
      coinflip: { n: number; lastedRate: number | null };
      safe: { n: number; lastedRate: number | null };
    };
    thresholds: { goneBelow: number; safeAbove: number };
  };
  tierGaps: TierGapStat[];
  hitRate: HitRate | null;
  closeCallsAtTop: number;
}

export function calibrateFromLog(
  meta: DraftLogMeta,
  events: readonly DraftLogEvent[],
  final: DraftLogFinal | null,
): CalibrationReport {
  const allLanded = events.flatMap((e) => e.landed);
  const eventualOverall = new Map<string, number>();
  for (const l of allLanded) {
    if (!eventualOverall.has(l.playerId)) eventualOverall.set(l.playerId, l.overall);
  }

  return {
    events: events.length,
    draftedPicks: allLanded.length,
    picksWithAdp: allLanded.filter((l) => l.adp != null).length,
    sigma: analyseSigma(allLanded, meta),
    reliability: analyseReliability(events, eventualOverall, meta),
    tierGaps: analyseTierGaps(allLanded, meta),
    hitRate: analyseHitRate(events, meta),
    closeCallsAtTop: countCloseCalls(events),
  };
}

/* ------------------------------------------------------------------ sigma --- */

function analyseSigma(landed: readonly LandedPick[], meta: DraftLogMeta): CalibrationReport["sigma"] {
  const pts = landed
    .filter((l): l is LandedPick & { adp: number; adpError: number } => l.adp != null && l.adpError != null)
    .map((l) => ({ adp: l.adp, err: l.adpError }));

  const c = meta.constants.survival;
  const currentSigmaAt = (adp: number): number =>
    clamp(adp * c.sigmaFraction, c.sigmaFloor, c.sigmaCeil);

  const bins: SigmaBin[] = ADP_BINS.map(([lo, hi, range]) => {
    const inBin = pts.filter((p) => p.adp >= lo && p.adp <= hi);
    const mid = Number.isFinite(hi) ? (lo + hi) / 2 : lo + 24;
    return {
      range,
      n: inBin.length,
      meanError: inBin.length ? mean(inBin.map((p) => p.err)) : null,
      stdev: inBin.length >= 2 ? stdev(inBin.map((p) => p.err)) : null,
      currentSigma: round2(currentSigmaAt(mid)),
    };
  });

  // Fit mean-absolute-deviation (centred) against ADP → sigma ≈ MAD_TO_SIGMA * (a + b·adp).
  let fit: CalibrationReport["sigma"]["fit"] = null;
  let suggested: CalibrationReport["sigma"]["suggested"] = null;
  if (pts.length >= 8) {
    const mErr = mean(pts.map((p) => p.err));
    const reg = linreg(pts.map((p) => ({ x: p.adp, y: Math.abs(p.err - mErr) })));
    fit = { intercept: round2(reg.intercept), slope: round3(reg.slope), r2: round2(reg.r2) };
    const maxAdp = Math.max(...pts.map((p) => p.adp));
    suggested = {
      fraction: round3(MAD_TO_SIGMA * reg.slope),
      floor: round2(Math.max(1, MAD_TO_SIGMA * reg.intercept)),
      ceil: round2(MAD_TO_SIGMA * (reg.intercept + reg.slope * maxAdp)),
    };
  }

  return {
    bins,
    fit,
    current: { fraction: c.sigmaFraction, floor: c.sigmaFloor, ceil: c.sigmaCeil },
    suggested,
  };
}

/* ------------------------------------------------------------ reliability --- */

function analyseReliability(
  events: readonly DraftLogEvent[],
  eventualOverall: ReadonlyMap<string, number>,
  meta: DraftLogMeta,
): CalibrationReport["reliability"] {
  const seen = new Set<string>();
  const samples: Array<{ prob: number; lasted: 0 | 1 }> = [];

  for (const e of events) {
    const target = e.advice.myNextOverall;
    if (target == null) continue;
    for (const rec of e.advice.recommendations) {
      if (rec.survivalProb == null) continue;
      const key = `${rec.playerId}@${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const went = eventualOverall.get(rec.playerId);
      const lasted: 0 | 1 = went == null || went >= target ? 1 : 0;
      samples.push({ prob: rec.survivalProb, lasted });
    }
  }

  const deciles: ReliabilityDecile[] = [];
  for (let d = 0; d < 10; d++) {
    const lo = d / 10;
    const hi = (d + 1) / 10;
    const inD = samples.filter((s) => s.prob >= lo && (d === 9 ? s.prob <= hi : s.prob < hi));
    if (!inD.length) continue;
    deciles.push({
      range: `${lo.toFixed(1)}-${hi.toFixed(1)}`,
      n: inD.length,
      predictedMean: round2(mean(inD.map((s) => s.prob))),
      observedLastedRate: round2(mean(inD.map((s) => s.lasted))),
    });
  }

  const { goneBelow, safeAbove } = meta.constants.survival;
  const band = (pred: (p: number) => boolean): { n: number; lastedRate: number | null } => {
    const g = samples.filter((s) => pred(s.prob));
    return { n: g.length, lastedRate: g.length ? round2(mean(g.map((s) => s.lasted))) : null };
  };

  return {
    n: samples.length,
    brier: samples.length ? round3(mean(samples.map((s) => (s.prob - s.lasted) ** 2))) : null,
    deciles,
    bucketCheck: {
      gone: band((p) => p < goneBelow),
      coinflip: band((p) => p >= goneBelow && p < safeAbove),
      safe: band((p) => p >= safeAbove),
    },
    thresholds: { goneBelow, safeAbove },
  };
}

/* -------------------------------------------------------------- tier gaps --- */

function analyseTierGaps(landed: readonly LandedPick[], meta: DraftLogMeta): TierGapStat[] {
  const positions = meta.constants.cliff.positions as Position[];
  const currentGap = meta.constants.cliff.vorTierGap;

  return positions.map((position) => {
    const vors = landed
      .filter((l) => l.position === position && l.vor != null)
      .sort((a, b) => a.overall - b.overall)
      .map((l) => l.vor as number);
    const gaps: number[] = [];
    for (let i = 1; i < vors.length; i++) {
      const g = vors[i - 1]! - vors[i]!;
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    return {
      position,
      n: gaps.length,
      p50: pctile(gaps, 0.5),
      p75: pctile(gaps, 0.75),
      p90: pctile(gaps, 0.9),
      max: gaps.length ? round2(gaps[gaps.length - 1]!) : null,
      currentGap,
    };
  });
}

/* --------------------------------------------------------------- hit rate --- */

function analyseHitRate(events: readonly DraftLogEvent[], meta: DraftLogMeta): HitRate | null {
  const slot = meta.slot ?? firstNonNull(events.map((e) => e.advice.slot));
  if (slot == null || slot < 1 || slot > meta.teams) return null;

  const mine = new Set(mySlots(slot, meta.teams, meta.rounds));
  const eventByOverall = new Map<number, DraftLogEvent>();
  for (const e of events) {
    if (mine.has(e.advice.overall)) eventByOverall.set(e.advice.overall, e); // last wins
  }
  const tookAt = new Map<number, string>();
  for (const e of events) {
    for (const l of e.landed) if (l.mine && mine.has(l.overall)) tookAt.set(l.overall, l.playerId);
  }

  const detail: HitRate["detail"] = [];
  let top1 = 0;
  let top3 = 0;
  let top6 = 0;
  for (const overall of [...mine].sort((a, b) => a - b)) {
    const ev = eventByOverall.get(overall);
    const took = tookAt.get(overall);
    if (!ev || !took) continue;
    const ids = ev.advice.recommendations.map((r) => r.playerId);
    const idx = ids.indexOf(took);
    const rankInList = idx === -1 ? null : idx + 1;
    if (rankInList != null && rankInList <= 1) top1++;
    if (rankInList != null && rankInList <= 3) top3++;
    if (rankInList != null && rankInList <= 6) top6++;
    detail.push({
      overall,
      took: ev.advice.recommendations[idx]?.name ?? took,
      rankInList,
    });
  }

  return { picks: detail.length, top1, top3, top6, detail };
}

function countCloseCalls(events: readonly DraftLogEvent[]): number {
  let n = 0;
  for (const e of events) {
    const recs = e.advice.recommendations;
    if (recs.length >= 2 && recs[0]!.score - recs[1]!.score < 10) n++;
  }
  return n;
}

/* --------------------------------------------------------------- rendering -- */

export function renderCalibration(r: CalibrationReport): string {
  const L: string[] = [];
  L.push(`# Draft calibration`);
  L.push(
    `${r.events} events · ${r.draftedPicks} picks recorded · ${r.picksWithAdp} with ADP\n`,
  );

  L.push(`## Survival sigma`);
  L.push(`current: sigma = clamp(adp × ${r.sigma.current.fraction}, ${r.sigma.current.floor}, ${r.sigma.current.ceil})`);
  L.push(`| ADP band | n | mean err | observed sd | model sigma |`);
  L.push(`| --- | --: | --: | --: | --: |`);
  for (const b of r.sigma.bins) {
    L.push(
      `| ${b.range} | ${b.n} | ${fmt(b.meanError)} | ${fmt(b.stdev)} | ${b.currentSigma} |`,
    );
  }
  if (r.sigma.suggested) {
    const s = r.sigma.suggested;
    L.push(
      `\nsuggested: sigma ≈ clamp(adp × ${s.fraction}, ${s.floor}, ${s.ceil})` +
        (r.sigma.fit ? `  (fit r² ${r.sigma.fit.r2})` : ""),
    );
  } else {
    L.push(`\nnot enough ADP'd picks to fit a curve.`);
  }

  L.push(`\n## Survival reliability  (${r.reliability.n} predictions${
    r.reliability.brier != null ? `, Brier ${r.reliability.brier}` : ""
  })`);
  if (r.reliability.deciles.length) {
    L.push(`| predicted P(lasts) | n | mean pred | actually lasted |`);
    L.push(`| --- | --: | --: | --: |`);
    for (const d of r.reliability.deciles) {
      L.push(`| ${d.range} | ${d.n} | ${d.predictedMean} | ${d.observedLastedRate} |`);
    }
  }
  const bc = r.reliability.bucketCheck;
  L.push(
    `\nbucket check — "gone" (p<${r.reliability.thresholds.goneBelow}) lasted ${fmt(bc.gone.lastedRate)} of ${bc.gone.n}` +
      `  ·  "coinflip" lasted ${fmt(bc.coinflip.lastedRate)} of ${bc.coinflip.n}` +
      `  ·  "safe" (p≥${r.reliability.thresholds.safeAbove}) lasted ${fmt(bc.safe.lastedRate)} of ${bc.safe.n}`,
  );
  L.push(`(want: gone ≈ 0, safe ≈ 1)`);

  L.push(`\n## Tier gaps (VOR, drafted order)`);
  L.push(`current VOR_TIER_GAP = ${r.tierGaps[0]?.currentGap ?? "?"}`);
  L.push(`| pos | gaps | p50 | p75 | p90 | max |`);
  L.push(`| --- | --: | --: | --: | --: | --: |`);
  for (const t of r.tierGaps) {
    L.push(`| ${t.position} | ${t.n} | ${fmt(t.p50)} | ${fmt(t.p75)} | ${fmt(t.p90)} | ${fmt(t.max)} |`);
  }
  L.push(`(a reasonable VOR_TIER_GAP ≈ the p75 of real drops)`);

  L.push(`\n## Recommendation hit rate`);
  if (r.hitRate) {
    const h = r.hitRate;
    L.push(`${h.picks} of my picks had advice: top-1 ${h.top1}, top-3 ${h.top3}, top-6 ${h.top6}`);
    for (const d of h.detail) {
      L.push(`  overall ${d.overall}: took ${d.took} — ${d.rankInList != null ? `#${d.rankInList} in the list` : "not shown"}`);
    }
  } else {
    L.push(`(no draft slot in the log — can't line up my picks)`);
  }

  L.push(`\n${r.closeCallsAtTop} of ${r.events} events had #1 and #2 within 10 score points (a bump could have decided the top pick).`);
  return L.join("\n");
}

/* ----------------------------------------------------------------- maths ---- */

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: readonly number[]): number {
  const m = mean(xs);
  return round2(Math.sqrt(mean(xs.map((x) => (x - m) ** 2))));
}

function pctile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return round2(sorted[i]!);
}

function linreg(pts: ReadonlyArray<{ x: number; y: number }>): {
  intercept: number;
  slope: number;
  r2: number;
} {
  const n = pts.length;
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { intercept, slope, r2 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function firstNonNull(xs: ReadonlyArray<number | null>): number | null {
  for (const x of xs) if (x != null) return x;
  return null;
}

function fmt(n: number | null): string {
  return n == null ? "—" : String(n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
