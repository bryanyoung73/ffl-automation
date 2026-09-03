# Live draft assistant

Date: 2026-09-03
Status: spec — not started

## Problem

The cheat sheet (`npm run cheatsheet`) is a static, pre-draft artifact: a ranked
board with ECR / VOR / chatter. During the draft itself it goes stale on the
first pick and gives no help with *the actual decision* — who's the best pick
**for my roster, right now, given what's already gone and who'll still be there
when I'm back on the clock**. This spec adds a live, in-draft companion that
keeps the board current as picks come off and turns it into a short, ranked
recommendation with reasons.

ESPN exposes the draft state through the same Fantasy v3 read API everything
else already uses (`view=mDraftDetail`), so this is a polling loop plus a pure
recommendation engine on top of the board we already build.

## Scope

**In:** a `npm run draft` command (ESPN, **snake only**) that, during a live or
commissioner-entered draft:

- polls the draft, subtracts drafted players from the board as picks land
- tracks **my roster so far** and computes **positional need** (starting slots
  left to fill, bench depth, positional scarcity vs. picks until my next turn)
- for each candidate, estimates **"will he last?"** — probability he's gone
  before my next pick, from ADP vs. the pick window
- detects **tier cliffs** ("2 players left before a 25-point TE drop") and
  **positional runs** ("5 of the last 8 picks were RB")
- prints a live-updating terminal view: my roster, top ~5 picks with one-line
  reasoning, tier cliffs, run alerts
- degrades gracefully: no `mDraftDetail` yet → static board; draft complete →
  say so and exit

**Out (later or separate specs):** auction drafts (different turn/needs math),
Yahoo (offline draft — no live feed), a full-screen TUI, trade-up/trade-down
advice, opponent-roster modelling, keeper-value adjustments, autodraft.

## Reuse — most of this exists

| Need | Existing piece |
| --- | --- |
| Ranked player universe (ADP, ECR, VOR, projections, chatter) | `provider.getDraftBoard()` → `buildBoard()` in `src/draft/board.ts` |
| Positional replacement value | `computeVor()` in `src/draft/vor.ts` |
| Consensus rank + tiers | `src/draft/ecr.ts` (`ecrTier` per entry) |
| Chatter / injury / role notes | `collectIntel(config, refs, { scope: "draft" })` |
| League shape (slots, teams, scoring, draft type) | `provider.getLeagueSettings()` |
| ESPN fetch + cookies + `x-fantasy-filter` | `EspnClient` |
| Board assembly (board + ECR + VOR + intel wiring) | lift the middle of `src/cli/cheatsheet.ts` into a shared helper |

The only genuinely new I/O is one endpoint (`mDraftDetail`); everything below it
is pure and fixture-testable.

## Approach

### 1. Draft state — `LeagueProvider.getDraftState()`

New method on the interface (`src/providers/types.ts`):

```ts
getDraftState(): Promise<DraftState>;
```

```ts
export interface DraftPick {
  overall: number;      // overallPickNumber
  round: number;        // roundId
  pickInRound: number;  // roundPickNumber
  teamId: number;
  playerId: string;     // String(playerId) — joins to BoardEntry.player.id
}
export interface DraftState {
  drafted: boolean;     // draft has completed
  inProgress: boolean;
  picks: DraftPick[];    // chronological; keeper picks included
}
```

**ESPN** (`src/providers/espn/EspnLeague.ts`): `client.get(["mDraftDetail"], { noCache: true })`
→ `raw.draftDetail.{drafted,inProgress,picks[]}`, map each pick. Keeper picks
(`pick.keeper === true`) are kept — a rostered player is unavailable however he
got there. Add a pure `mapDraftState(raw)` exported for tests.

**Yahoo** (`src/providers/yahoo/YahooLeague.ts`): `throw` a `NOT_SUPPORTED`
error with the same shape as `getFreeAgents` — "Live draft assistant is
ESPN-only (Yahoo drafts run off-platform). Set PROVIDER=espn."

**`EspnClient.get` cache bypass** — `get()` has a per-process memo; the poll
loop must not be served a stale draft. Add `opts.noCache?: boolean` that skips
both the read and the write of `getCache` for that call. One-line change,
covered by an existing-style client test.

### 2. Snake turn math — `src/draft/live/snake.ts` (pure)

```ts
mySlots(slot: number, teams: number, rounds: number): number[]      // overall pick numbers that are mine
picksUntilNext(overallJustMade: number, mine: number[]): number     // 0 = I'm on the clock
picksUntilAfter(overallJustMade: number, mine: number[]): number    // for the "two turns out" view
```

`rounds` = total starting slots + `benchSize` (from settings). `slot` comes
from §6 (auto-detected, or `--slot`).

### 3. Roster + needs — `src/draft/live/needs.ts` (pure)

```ts
myRoster(state: DraftState, myTeamId: number, board: BoardEntry[]): BoardEntry[]
rosterNeeds(mine: BoardEntry[], settings: LeagueSettings): PositionNeed[]
```

`PositionNeed` per position: `startersLeft` (dedicated + share of FLEX still
open), `haveStarters`, `haveBench`, and a scalar `weight` used by the engine:

- `weight` rises as `startersLeft` rises and falls once starting slots are full
  (a 3rd RB with 2 RB slots filled is bench depth, not need)
- a small floor so a full position never goes to exactly 0 (handcuffs, upside)
- FLEX shared across RB/WR/TE proportional to how each stacks up

Pure, no board mutation — takes entries, returns plain numbers.

### 4. Survival — `src/draft/live/survival.ts` (pure)

```ts
willLast(adp: number | null, nextPickOverall: number): Survival
```

`Survival = { prob: number; bucket: "gone" | "coinflip" | "safe" }`. Model:
treat draft position as roughly normal around ADP with a spread that widens with
ADP (`sigma ≈ clamp(adp * 0.15, 4, 18)`); `prob` = P(actual pick ≥ my next
pick). No ADP → `bucket: "safe"`, `prob: null` (can't reason, don't penalise).
Buckets: `prob < 0.15` → `gone`, `< 0.6` → `coinflip`, else `safe`. Thresholds
are module constants, easy to tune after a live run.

### 5. Tier cliffs + runs — `src/draft/live/context.ts` (pure)

```ts
tierCliffs(available: BoardRow[], settings): Cliff[]
positionRuns(state: DraftState, board, window?: number): Run[]
```

- **Cliff** per position: players remaining in the current value tier and the
  size of the drop to the next. Use `ecrTier` when present; otherwise bucket by
  a projection/VOR gap threshold. Emit only when the tier is nearly exhausted
  (`remaining <= 3`) and the drop is meaningful.
- **Run**: over the last `window` picks (default `teams`, ~one round), count by
  position; flag a position at `>= ceil(window * 0.5)`. Feeds a "if you want one
  this tier, now" nudge and bumps that position's urgency slightly.

### 6. Engine + orchestrator — `src/draft/live/assistant.ts` (pure)

```ts
computeAdvice(input: {
  board: Board;                 // from buildBoard (carries VOR, ECR, intel, tiers)
  state: DraftState;
  myTeamId: number;
  mySlot: number | null;
  settings: LeagueSettings;
}): DraftAdvice
```

`DraftAdvice` (everything the renderer needs, no I/O):

- `onClock: boolean`, `overall: number`, `myNextOverall: number | null`,
  `picksUntilNext: number | null`, `pctComplete: number`
- `myRoster: { pos: Position; players: string[] }[]`
- `recommendations: Rec[]` — top N (default 6), each:
  - `player`, `adp`, `vor`, `vorRank`, `ecrPosRank`, `needWeight`, `survival`
  - `score` — the ranking number: normalised VOR (or ECR when VOR absent, e.g.
    IDP/K/DEF) × need weight, with a small survival bonus (prioritise a
    `coinflip` you may not get again over a `safe` pick) and a small run bump
  - `reasons: string[]` — 1–3 short clauses: `"fills your 2nd RB slot"`,
    `"WR5 by ECR, ADP 34 — won't last to 41"`, `"last elite TE (28-pt cliff)"`,
    `"knee — limited in practice"` (top intel note)
- `cliffs: Cliff[]`, `runs: Run[]`

Slot auto-detection: once `state.picks` has a round-1 pick for `myTeamId`, that
`pickInRound` **is** `mySlot`. Until then use `--slot`; if neither, `mySlot =
null` → skip survival/turn math, still rank by need-adjusted value.

### 7. Shared board assembly — `src/draft/assemble.ts`

Lift the board-building middle of `cheatsheet.ts` (getDraftBoard → fetchEcr /
attachEcr → collectIntel → buildBoard) into:

```ts
assembleBoard(config, provider, opts: {
  llm?: boolean; noEcr?: boolean; noIntel?: boolean;
  intelDepth?: number; refresh?: boolean;
}): Promise<{ board: Board; league: LeagueSettings; intelAsOf: string }>
```

`cheatsheet.ts` and `draft.ts` both call it. No behaviour change to the cheat
sheet — this is an extract-function refactor with the existing board tests as
the safety net.

### 8. CLI — `src/cli/draft.ts` → `npm run draft`

```
npm run draft
npm run draft -- --slot 7          # my draft position (else auto-detected from pick 1)
npm run draft -- --interval 4      # poll seconds (default 5)
npm run draft -- --once            # print advice once and exit (slow drafts / testing)
npm run draft -- --no-intel        # skip chatter; --llm for the digest; --no-ecr
npm run draft -- --top 8           # recommendations to show (default 6)
```

Flow:

1. `assembleBoard(...)` once — board + league + intel.
2. Resolve `myTeamId` from `config.espn.teamId`.
3. Loop every `interval`s: `provider.getDraftState()`; if `picks.length`
   unchanged and not first iteration, `continue`; else `computeAdvice(...)` and
   re-render.
4. `state.drafted` → render a final "draft complete — N picks, here's your
   roster" and exit 0.
5. `SIGINT` → clean exit.

**Render** (plain `console.clear()` + reprint, no TUI dependency):

```
DRAFT · pick 3.07 (overall 31)  ·  your next: overall 41 (+10)  ·  38% done

Your roster
  QB  —            RB  Bijan Robinson, Kyren Williams
  WR  CeeDee Lamb  TE  —            FLEX —

Pick now
  1. Brock Bowers      TE  LV   ADP 29  VOR +41 (TE2)   fills TE · last elite TE, 26-pt cliff
  2. Garrett Wilson    WR  NYJ  ADP 33  VOR +38 (WR8)   WR depth · coinflip to last to 41
  3. Kyren who? ...
  ...

Tier cliffs
  TE  2 left this tier (Bowers, Kittle) then -26
  QB  4 left before the streamer tier

Runs
  RB  5 of the last 8 picks — the RB2 tier is thinning
```

## Modules

```
src/draft/
  assemble.ts            PURE-ish  board+ecr+vor+intel assembly (shared with cheatsheet)
  live/
    snake.ts             PURE  mySlots / picksUntilNext / picksUntilAfter
    needs.ts             PURE  myRoster / rosterNeeds
    survival.ts          PURE  willLast
    context.ts           PURE  tierCliffs / positionRuns
    assistant.ts         PURE  computeAdvice -> DraftAdvice
    types.ts             DraftAdvice, Rec, PositionNeed, Survival, Cliff, Run
src/providers/
  types.ts               + getDraftState(): Promise<DraftState>  (+ DraftState/DraftPick)
  espn/EspnLeague.ts     mapDraftState + getDraftState (mDraftDetail, noCache)
  espn/client.ts         get(opts.noCache?) — bypass the per-process memo
  yahoo/YahooLeague.ts   getDraftState -> throw NOT_SUPPORTED
src/cli/draft.ts         npm run draft  (poll loop + render)
tests/
  espn-draft-state.spec.ts   mDraftDetail fixture -> DraftState (incl. keepers, mid-draft)
  draft-snake.spec.ts        slot->my picks, snake wrap, picks-until-next at boundaries
  draft-needs.spec.ts        starters-left vs bench depth, FLEX share, full-position floor
  draft-survival.spec.ts     gone/coinflip/safe buckets, null ADP, sigma widening
  draft-context.spec.ts      cliff only when tier near-empty + drop is real; run threshold
  draft-assistant.spec.ts    end-to-end pure: fixture board + fixture picks -> ranked recs
                             with expected reasons; slot auto-detect from pick 1;
                             graceful path when mySlot is null
tests/fixtures/
  espn-draft-detail.sample.json   hand-built mid-draft mDraftDetail
```

`package.json`: add `"draft": "tsx src/cli/draft.ts"` and the six specs to
`test:unit`.

## Phases

1. **Provider + state** — `getDraftState`, `mapDraftState`, `noCache`, Yahoo
   stub, fixture + `espn-draft-state.spec.ts`. (~0.5 day)
2. **Turn + needs math** — `snake.ts`, `needs.ts`, `assemble.ts` extract,
   tests. (~1.5 days)
3. **Survival + context** — `survival.ts`, `context.ts`, tests. (~1 day)
4. **Engine** — `assistant.ts` `computeAdvice`, `draft-assistant.spec.ts`.
   (~1.5–2 days)
5. **CLI + render** — `src/cli/draft.ts`, poll loop, terminal view, `--once`
   for iterating without a live draft. (~1 day)

~5–7 days. Phases 1–4 are pure and verifiable now with fixtures; phase 5 and
live polling can only be shaken out against a real draft.

## Testing

- Pure modules against fixtures, same pattern as `board.spec.ts` /
  `waiver-pairs.spec.ts` — no network in CI.
- `--once` against a captured `mDraftDetail` + a real board gives a
  deterministic render to snapshot.
- Live poll loop stays out of CI; manual checklist for draft day below.

## Live verification (draft day)

1. `npm run draft -- --once` an hour before — board assembles, "draft not
   started", static top-6 by need shows.
2. After pick 1, confirm `mySlot` auto-detected matches `--slot`.
3. Mid-draft: picks disappear from recommendations within one `interval`;
   `picksUntilNext` counts down correctly through a snake turn.
4. On the clock: `onClock: true`, recommendations stable, reasons read right.
5. `state.drafted` after the last pick → clean exit with final roster.

## Addendum — Phase 1 shipped (2026-09-03)

Built: `DraftState` / `DraftPick` on `src/providers/types.ts`;
`LeagueProvider.getDraftState()`; ESPN `mapDraftState(mDraftDetail)` (pure,
exported) + `getDraftState()` fetching `["mDraftDetail"]` with a new
`EspnClient.get({ noCache: true })` bypass so the poll loop never sees a stale
memo; Yahoo `getDraftState()` throws `NOT_SUPPORTED`.
`tests/fixtures/espn-draft-detail.sample.json` (10-team snake, 15 picks, one
keeper, round-2 snake reversal) + `tests/espn-draft-state.spec.ts` — 7 tests
(flags, order, keeper handling, snake reversal, out-of-order sort + empty-slot
drop, missing `draftDetail`, finished draft). `test:unit` updated. Typecheck
clean, 110 unit tests pass.

**The auth risk is retired.** `getDraftState()` ran live against the real
league (1144783883) with the existing `ESPN_S2` / `ESPN_SWID` cookies —
`mDraftDetail` returns 200, no separate draft-room session needed. The league
is still undrafted (`drafted: false, picks: 0`), so pick-by-pick flow can't be
watched until it drafts, but the endpoint and mapper are proven.

## Addendum — Phase 2 shipped (2026-09-03)

Built:

- `src/draft/live/snake.ts` (pure) — `mySlots(slot, teams, rounds)`,
  `picksUntilNext(completed, mine)` (0 = on the clock), `picksUntilAfter`,
  `nextPick`. `mySlots` throws on an out-of-range slot.
- `src/draft/live/needs.ts` (pure) — `myRoster(state, myTeamId, board)`
  (resolves my picks against the board for positions; drops other teams and
  off-board keepers) and `rosterNeeds(mine, settings) → PositionNeed[]`. Weight
  curve: `1 + startersLeft + flexShare` while a slot is open, a per-position
  `DEPTH_FLOOR` once set (RB 0.55 … K/DEF 0.1); K/DEF capped at 0.9 so they
  never climb into the early rounds; FLEX share is split across RB/WR/TE
  proportional to their dedicated slots and is consumed as bench bodies pile up.
- `src/draft/live/types.ts` — `PositionNeed` (engine output types land in
  phase 4).
- `src/draft/assemble.ts` — `assembleBoard(config, provider, opts)` lifts the
  board pipeline (getDraftBoard → fetchEcr/attachEcr → collectIntel →
  buildBoard) out of `cheatsheet.ts`; returns `{ league, entries, intel,
  intelAsOf, board }`. Progress goes to an injected `log` (silent by default).
  `cheatsheet.ts` is now a thin caller — output verified byte-compatible
  against a live `--pos QB` run.

`tests/draft-snake.spec.ts` (6) + `tests/draft-needs.spec.ts` (5), wired into
`test:unit`. Typecheck clean, 121 unit tests pass.

## Addendum — Phase 3 shipped (2026-09-03)

Built:

- `src/draft/live/survival.ts` (pure) — `willLast(adp, nextPickOverall) →
  { prob, bucket }`. Draft slot modelled as `Normal(adp, sigma)` with
  `sigma = clamp(adp * 0.15, 4, 18)` (deeper players go in a wider window);
  `prob = P(slot ≥ my next pick)` via an inline erf/normal-CDF approximation.
  Buckets: `< 0.15` gone, `< 0.6` coinflip, else safe. Null ADP →
  `{ prob: null, bucket: "safe" }` — no signal, no penalty. Thresholds are
  module constants.
- `src/draft/live/context.ts` (pure):
  - `tierCliffs(available, settings) → Cliff[]` — per QB/RB/WR/TE, prefers
    FantasyPros ECR tiers (`row.ecrTier`), falls back to a VOR-gap cut (≥ 12),
    skips a position with neither. Emits only when the tier is down to ≤ 3 and
    the drop clears a floor (10 VOR pts / 8 ADP slots); `drop` is tagged
    `"vor"` or `"adp"`.
  - `positionRuns(state, board, window=teams) → Run[]` — count the last
    `window` picks by position (picks off the board ignored); flags a position
    at `≥ max(4, ceil(window/2))`, requires ≥ 6 picks in the window first.
- `src/draft/live/types.ts` — added `Cliff`, `Run`.

`tests/draft-survival.spec.ts` (6) + `tests/draft-context.spec.ts` (9), wired
into `test:unit`. Typecheck clean, 136 unit tests pass.

## Open items / risks

- ~~**Live auth is unverified.**~~ Resolved in Phase 1 — `mDraftDetail` returns
  200 with the existing cookies. Still unproven: whether picks land in that
  payload fast enough during a *live* (clock-running) draft vs. a
  commissioner-entered one. Polling cadence may need tuning on the day.
- **The ESPN league may already have drafted.** Undrafted as of 2026-09-01;
  re-check before building. If it has drafted, this ships dark until next
  season (fixtures still let phases 1–4 land and stay tested).
- **Snake only.** Auction needs different turn/needs/`willLast` math — separate
  phase.
- **Polling etiquette.** ~4–5s for up to ~2h. Back off (double the interval,
  cap ~30s) on any fetch error; never hammer.
- **Slot detection before round 1.** No round-1 pick for my team yet → rely on
  `--slot`; with neither, run without survival/turn math (still useful).
- **Keeper-heavy leagues.** Keeper picks consume roster spots but not "live"
  clock picks; v1 treats any pick with a `playerId` as simply unavailable and
  doesn't model keeper cost.
