# Draft recorder + post-draft calibration

Date: 2026-09-03
Status: spec — not started. Intended as phase 6 of the live draft assistant.

## Problem

The live draft assistant (`npm run draft`,
`docs/specs/2026-09-03-live-draft-assistant.md`) scores picks with hand-chosen
constants — `SIGMA_FRACTION / SIGMA_FLOOR / SIGMA_CEIL` and the bucket
thresholds in `survival.ts`, `VOR_TIER_GAP` + the cliff floors in `context.ts`,
the additive bumps in `assistant.ts`. A single synthetic `--once` run against
the live board already showed two are off: the sigma floor of 4 is too wide at
the very top of the board (the #1 pick reads "coin-flip to last to 5"), and
`VOR_TIER_GAP = 12` cuts a tier after one player when ECR is unavailable.

There is no way to tune these without watching a real draft, and a real draft
happens once a year. So: capture the draft as it happens, and turn the log into
calibrated constant suggestions afterward.

## Scope

**In:**
- `--record` on `npm run draft` — append one JSONL event per recompute to
  `output/draft-log-<leagueId>-<date>.jsonl`: the pick(s) that landed since the
  last event (joined to their board ADP/VOR/ECR), the advice snapshot shown at
  that moment, and — at my picks — what the tool ranked.
- A self-describing header event: league shape + the constant values in force,
  so a log tells you what it was recorded against.
- `npm run draft:review -- <logfile>` — a pure analysis command that prints a
  calibration report: the observed `sigma(adp)` curve, survival-bucket
  reliability, the VOR tier-gap distribution, recommendation hit rate, and
  suggested constant values.

**Out:**
- Live self-adjustment (fitting sigma from the draft in progress) — see Open
  items; deferred, probably not worth it in a 10-team draft.
- Auto-patching the constants — the review command *suggests*; a human edits.
- Recording anything but the draft (a weekly start/sit decision audit is a
  separate idea).

## Reuse

| Need | Existing piece |
| --- | --- |
| Pick stream | `provider.getDraftState()` → `DraftState.picks` |
| ADP / VOR / ECR / tier per drafted player | `board.rows` keyed by `player.id` (the CLI already holds the board) |
| Advice snapshot | `computeAdvice` → `DraftAdvice` |
| My pick numbers | `mySlots(slot, teams, rounds)` in `snake.ts` |
| Normal CDF for the reliability check | `normCdf` in `survival.ts` (export it) |
| Constants under test | module locals in `survival.ts` / `context.ts` / `assistant.ts` (export as frozen bundles) |

## Approach

### 1. Event shape — `src/draft/live/record.ts` (pure)

One JSONL file per draft. First line is a meta event, then one event per
recompute, then a final event.

```ts
interface DraftLogMeta {
  kind: "meta";
  at: string;
  leagueId: string;
  teams: number;
  scoring: string;
  rounds: number;              // starters + bench
  starters: Record<string, number>;
  boardSize: number;
  ecrMatched: number;          // rows joined to FantasyPros ECR
  gitSha: string | null;
  constants: {
    survival: typeof SURVIVAL_CONSTANTS;
    cliff: typeof CLIFF_CONSTANTS;
    score: typeof SCORE_CONSTANTS;
  };
}

interface DraftLogEvent {
  kind: "event";
  at: string;
  pickCount: number;           // state.picks.length after this event
  landed: LandedPick[];        // picks since the previous event (≥1; more if polling lagged)
  advice: AdviceSnapshot;      // trimmed DraftAdvice as shown
}

interface LandedPick {
  overall: number;
  round: number;
  teamId: number;
  playerId: string;
  name: string;
  position: Position;
  adp: number | null;          // the prediction input
  ecrRank: number | null;
  ecrTier: number | null;
  vor: number | null;
  vorRank: number | null;
  adpError: number | null;     // overall − adp — the calibration target
}

interface AdviceSnapshot {
  onClock: boolean;
  overall: number;
  myNextOverall: number | null;
  slot: number | null;
  recommendations: Array<{
    playerId: string; name: string; position: Position;
    score: number; adp: number | null;
    survivalProb: number | null; survivalBucket: SurvivalBucket;
  }>;
  cliffs: Cliff[];
  runs: Run[];
}

interface DraftLogFinal {
  kind: "final";
  at: string;
  totalPicks: number;
  myRoster: Array<{ overall: number; playerId: string; name: string; position: Position }>;
}
```

`record.ts` exports pure builders:
- `buildMeta(config, league, board, ecrMatched, constants, gitSha) → DraftLogMeta`
- `buildEvent(prevPickCount, state, board, advice, now) → DraftLogEvent` — diffs
  `state.picks` past `prevPickCount`, joins each new pick to its board row
  (nulls when the player is deeper than the board), computes `adpError`
- `buildFinal(state, board, mySlots, now) → DraftLogFinal`

Writing is one `appendFileSync(path, JSON.stringify(ev) + "\n")` in the CLI —
not in the pure module.

**Constant bundles** — add to each module (the locals already exist; just also
export a frozen object):
```ts
// survival.ts
export const SURVIVAL_CONSTANTS = Object.freeze({
  sigmaFraction: SIGMA_FRACTION, sigmaFloor: SIGMA_FLOOR, sigmaCeil: SIGMA_CEIL,
  goneBelow: GONE_BELOW, safeAbove: SAFE_ABOVE,
});
```
Same for `CLIFF_CONSTANTS` (context.ts) and `SCORE_CONSTANTS` (assistant.ts).

### 2. CLI wiring — `src/cli/draft.ts`

- `--record` (opt-in for now; see Open items). Path
  `output/draft-log-<leagueId>-<YYYY-MM-DD>.jsonl`; append if it exists
  (resume-safe).
- After `assembleBoard`: write the meta event.
- In the poll loop, when `state.picks.length !== lastCount`: after `render`,
  append `buildEvent(lastCount, state, board, advice, new Date())`.
- On `state.drafted`: append `buildFinal(...)`.
- One line at exit: `recorded N events → <path>`.

### 3. Analyzer — `src/draft/live/calibrate.ts` (pure)

```ts
calibrateFromLog(meta: DraftLogMeta, events: DraftLogEvent[], final: DraftLogFinal | null)
  → CalibrationReport
```

**a. `sigma(adp)` curve.** From every `LandedPick` with an `adp`, collect
`adpError`. Bin by ADP range (1–12, 13–36, 37–72, 73–120, 121+). Per bin: n,
mean (bias — is the board's ADP shifted?), stdev (the empirical sigma for that
band). Also least-squares fit `sigma = a + b·adp` over the raw points. Present
alongside the current `clamp(adp·SIGMA_FRACTION, FLOOR, CEIL)` with a one-line
suggestion per constant.

**b. Survival-bucket reliability.** For each recorded recommendation with a
`survivalProb` and a known `myNextOverall`, check whether that player was still
available at my next pick (scan later `landed` + the final roster). Bucket by
predicted-prob decile → observed "still there" rate; a calibrated model has
predicted ≈ observed. Print the reliability table + a Brier score, and whether
`GONE_BELOW` / `SAFE_ABOVE` sit at sensible points on the curve.

**c. Tier-gap distribution.** Per position, from pick order, the sequence of
VORs of players actually drafted there, and the gaps between consecutive ones.
Histogram + percentiles. Suggest `VOR_TIER_GAP` ≈ the 75th percentile (or the
visible knee). Also: how many cliffs the tool showed vs how many were followed
by a real ≥`CLIFF_MIN_VOR_DROP` drop in what got drafted.

**d. Recommendation hit rate.** At each of my picks (from `meta` slot + snake
math), was my actual next pick in the tool's top 1 / 3 / 6? Print the rates.

**e. Bump sanity (light).** For each event, recompute the top-1 with each
additive bump zeroed; count how often `RUN_BUMP` / `CLIFF_BUMP` / the survival
bonus changed #1. Not a hard calibration — a "are these doing something / too
much" check.

`CalibrationReport` is plain data; `renderCalibration(report) → string` formats
it.

### 4. Review CLI — `src/cli/draft-review.ts` → `npm run draft:review -- <logfile>`

Read the JSONL (line 1 = meta, middle = events, last = final if present), run
`calibrateFromLog`, print `renderCalibration`. `--csv` dumps the raw
`(adp, adpError, position)` points for your own plotting. No network, no
provider.

## Modules

```
src/draft/live/
  record.ts       PURE  DraftLog* types + buildMeta / buildEvent / buildFinal
  calibrate.ts    PURE  calibrateFromLog -> CalibrationReport + renderCalibration
  survival.ts     + export SURVIVAL_CONSTANTS, export normCdf
  context.ts      + export CLIFF_CONSTANTS
  assistant.ts    + export SCORE_CONSTANTS
src/cli/
  draft.ts        + --record  -> output/draft-log-<leagueId>-<date>.jsonl
  draft-review.ts   npm run draft:review -- <logfile>
tests/
  draft-record.spec.ts     buildEvent diffs picks past prevCount, joins ADP,
                           computes adpError; off-board pick -> null fields, not
                           dropped; buildMeta captures the constant bundles
  draft-calibrate.spec.ts  sigma bins + least-squares fit recover a planted
                           sigma within tolerance; reliability table; tier-gap
                           percentile; hit rate from a canned pick sequence
tests/fixtures/
  draft-log.sample.jsonl   ~30 events, adpError ~ Normal(0, planted) per band so
                           the recovered value is assertable
package.json     + "draft:review": "tsx src/cli/draft-review.ts"
```

## Phases

1. **Recorder** — event types + builders, export the constant bundles, wire
   `--record` into `draft.ts`, `draft-record.spec.ts`. **Must exist before the
   draft.** (~0.5 day)
2. **Analyzer** — `calibrateFromLog` (sigma curve, reliability, tier gaps, hit
   rate), `renderCalibration`, `draft-review.ts`, `draft-calibrate.spec.ts`.
   Runs on the saved log, so it can land any time before or after the draft.
   (~1–1.5 days)

## Testing

- `buildEvent` against a fixture `DraftState` + `Board`: 1 new pick → 1
  `landed` with the right `adpError`; 3 new picks after a lagged poll → 3; a
  pick whose player isn't on the board → a `landed` entry with null ADP/VOR,
  not omitted.
- `calibrateFromLog` against `draft-log.sample.jsonl` built with
  `adpError ~ Normal(0, planted_sigma)` per band → recovered stdev and
  least-squares slope within tolerance.
- Reliability: a log where every "gone"-bucket player was in fact gone →
  observed rate ≈ 1 in that decile.
- Hit rate: canned meta slot + a pick sequence where my actual pick is 2nd in
  the shown list → top-1 miss, top-3 hit.
- All pure — no network.

## Open items

- **`--record` default-on vs opt-in.** Append-only JSONL, a few KB for a whole
  draft, and you get one shot at a real draft a year — leaning toward
  default-on with a `--no-record` escape hatch. Spec currently says opt-in;
  decide at implementation.
- **Live self-adjust deferred, and probably not worth it.** In a 10-team draft,
  30 picks is round 3 — an empirically-fit sigma wouldn't have the data to
  matter until the draft is half over, by which point the early-round picks
  (where survival calls matter most) are already made. Only revisit if this
  recorder shows the *static* curve is badly miscalibrated in a way a small
  prior tweak can't fix. If revisited: start the fit early with a strong prior
  and wide confidence bands rather than waiting for n = 30.
- **One draft is ~180 picks but low diversity** — one room, one year. Treat the
  first report's suggestions as directional; the value compounds only if the
  log format stays stable across seasons and logs are pooled.
- **Cross-season pooling / retention.** `output/` is gitignored wholesale;
  decide whether kept logs move somewhere tracked. Defer until there's a second
  one.
- **`normCdf` export** from `survival.ts` for the reliability check vs
  re-implementing in `calibrate.ts` — just export it.
- **Trimming the advice snapshot.** Full `DraftAdvice` per event is fine size-
  wise (~1–2 KB); the spec trims it anyway for a cleaner log. Confirm the
  trimmed shape carries everything the analyzer needs before phase 1 ships (it
  drives phase 2).
