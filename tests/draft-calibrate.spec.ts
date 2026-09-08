import { test, expect } from "@playwright/test";
import { calibrateFromLog, renderCalibration } from "../src/draft/live/calibrate.js";
import { SURVIVAL_CONSTANTS } from "../src/draft/live/survival.js";
import { CLIFF_CONSTANTS } from "../src/draft/live/context.js";
import { SCORE_CONSTANTS } from "../src/draft/live/assistant.js";
import type {
  AdviceSnapshot,
  DraftLogEvent,
  DraftLogMeta,
  LandedPick,
  RecSnapshot,
} from "../src/draft/live/record.js";
import type { SurvivalBucket } from "../src/draft/live/survival.js";
import type { Position } from "../src/draft/types.js";

function meta(slot: number | null = 5): DraftLogMeta {
  return {
    kind: "meta",
    at: "t",
    version: 1,
    leagueId: "L",
    teamId: 5,
    teams: 10,
    scoring: "ppr",
    rounds: 15,
    starters: {},
    boardSize: 300,
    ecrMatched: 200,
    slot,
    constants: { survival: SURVIVAL_CONSTANTS, cliff: CLIFF_CONSTANTS, score: SCORE_CONSTANTS },
  };
}

function landed(p: Partial<LandedPick> & { overall: number }): LandedPick {
  const adp = p.adp ?? null;
  return {
    overall: p.overall,
    round: p.round ?? Math.ceil(p.overall / 10),
    teamId: p.teamId ?? 1,
    playerId: p.playerId ?? `p${p.overall}`,
    name: p.name ?? `P${p.overall}`,
    position: p.position ?? null,
    adp,
    ecrRank: p.ecrRank ?? null,
    ecrTier: p.ecrTier ?? null,
    vor: p.vor ?? null,
    vorRank: p.vorRank ?? null,
    adpError: p.adpError ?? (adp != null ? p.overall - adp : null),
    mine: p.mine ?? false,
  };
}

function snap(playerId: string, prob: number | null, bucket: SurvivalBucket): RecSnapshot {
  return { playerId, name: playerId, position: "RB", score: 100, adp: null, survivalProb: prob, survivalBucket: bucket, vona: null, ceilRank: null, floorRank: null, rankStd: null };
}

function ev(picks: LandedPick[], advice: Partial<AdviceSnapshot> = {}): DraftLogEvent {
  return {
    kind: "event",
    at: "t",
    pickCount: 0,
    landed: picks,
    advice: {
      onClock: false,
      overall: 0,
      label: "",
      myNextOverall: null,
      picksUntilNext: null,
      slot: null,
      recommendations: [],
      cliffs: [],
      runs: [],
      ...advice,
    },
  };
}

test("sigma bins recover the observed standard deviation of adp error", () => {
  const picks = Array.from({ length: 20 }, (_, i) =>
    landed({ overall: 100 + i, adp: 20 + (i % 10), adpError: i % 2 === 0 ? 5 : -5, position: "RB" }),
  );
  const r = calibrateFromLog(meta(), [ev(picks)], null);
  const bin = r.sigma.bins.find((b) => b.range === "13-36")!;
  expect(bin.n).toBe(20);
  expect(bin.meanError).toBeCloseTo(0, 5);
  expect(bin.stdev).toBeCloseTo(5, 5);
  // model sigma at the bin midpoint (24.5) = clamp(24.5 * 0.15, 4, 18) ≈ 3.68 -> floored to 4
  expect(bin.currentSigma).toBe(4);
});

test("survival bucket check: 'gone' picks that went early score 0, 'safe' picks that lasted score 1", () => {
  const events = [
    ev(
      [landed({ overall: 12, adp: 10, playerId: "goner" })],
      {
        myNextOverall: 16,
        recommendations: [snap("goner", 0.08, "gone"), snap("stayer", 0.92, "safe")],
      },
    ),
  ];
  const r = calibrateFromLog(meta(), events, null);
  expect(r.reliability.bucketCheck.gone).toEqual({ n: 1, lastedRate: 0 }); // goner drafted at 12 < 16
  expect(r.reliability.bucketCheck.safe).toEqual({ n: 1, lastedRate: 1 }); // stayer never drafted
  // mean squared error of [0.08 vs 0, 0.92 vs 1] = 0.0064, rounded to 3 places
  expect(r.reliability.brier).toBe(0.006);
});

test("a prediction is counted once per (player, my-next-pick)", () => {
  const rec = { myNextOverall: 16, recommendations: [snap("x", 0.5, "coinflip")] };
  const r = calibrateFromLog(meta(), [ev([], rec), ev([], rec), ev([], rec)], null);
  expect(r.reliability.n).toBe(1);
});

test("tier gaps are the positive VOR drops between consecutively drafted players", () => {
  const picks = [
    landed({ overall: 1, position: "RB", vor: 100 }),
    landed({ overall: 5, position: "RB", vor: 90 }),
    landed({ overall: 9, position: "RB", vor: 88 }),
    landed({ overall: 20, position: "RB", vor: 50 }),
    landed({ overall: 25, position: "RB", vor: 48 }),
  ];
  const r = calibrateFromLog(meta(), [ev(picks)], null);
  const rb = r.tierGaps.find((t) => t.position === "RB")!;
  expect(rb.n).toBe(4); // gaps 10, 2, 38, 2
  expect(rb.max).toBe(38);
  expect(rb.p50).toBe(2);
  expect(rb.p75).toBe(10);
  expect(rb.currentGap).toBe(12);
});

test("hit rate lines my picks up against what the tool ranked", () => {
  // slot 5, 10 teams, 15 rounds → my first pick is overall 5
  const events = [
    ev(
      [landed({ overall: 5, teamId: 5, playerId: "mypick", mine: true, position: "RB" })],
      {
        overall: 5,
        myNextOverall: 5,
        recommendations: [snap("other", 0.5, "coinflip"), snap("mypick", 0.5, "coinflip")],
      },
    ),
  ];
  const r = calibrateFromLog(meta(5), events, null);
  expect(r.hitRate).not.toBeNull();
  expect(r.hitRate!.picks).toBe(1);
  expect(r.hitRate!.top1).toBe(0);
  expect(r.hitRate!.top3).toBe(1);
  expect(r.hitRate!.detail[0]).toMatchObject({ overall: 5, took: "mypick", rankInList: 2 });
});

test("hit rate is null when no draft slot is anywhere in the log", () => {
  const r = calibrateFromLog(meta(null), [ev([landed({ overall: 1 })])], null);
  expect(r.hitRate).toBeNull();
});

test("empty-ish log does not throw and renders", () => {
  const r = calibrateFromLog(meta(), [ev([])], null);
  expect(r.sigma.suggested).toBeNull();
  expect(r.reliability.n).toBe(0);
  expect(renderCalibration(r)).toContain("Draft calibration");
});

test("a linear sigma curve is fit and scaled to a suggestion", () => {
  // |error| grows with adp: at adp 10 spread ~2, at adp 100 spread ~20
  const picks: LandedPick[] = [];
  for (let i = 0; i < 40; i++) {
    const adp = 10 + i * 3; // 10 .. 127
    const spread = adp * 0.2;
    const err = i % 2 === 0 ? spread : -spread;
    picks.push(landed({ overall: Math.round(adp) + (i % 2 === 0 ? spread : -spread), adp, adpError: err, position: (["RB", "WR", "TE", "QB"] as Position[])[i % 4] }));
  }
  const r = calibrateFromLog(meta(), [ev(picks)], null);
  expect(r.sigma.fit).not.toBeNull();
  expect(r.sigma.suggested).not.toBeNull();
  // fitted MAD slope ≈ 0.2, scaled by 1.2533 → suggested fraction ≈ 0.25
  expect(r.sigma.suggested!.fraction).toBeGreaterThan(0.2);
  expect(r.sigma.suggested!.fraction).toBeLessThan(0.32);
});
