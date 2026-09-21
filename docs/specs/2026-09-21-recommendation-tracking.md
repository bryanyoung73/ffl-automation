# Recommendation tracking: were we right?

Date: 2026-09-21
Status: Phase 1 shipped (recording); phases 2-4 (grading, CLI report,
dashboard panel) not started

## Addendum — phase 1 shipped

`getWeekResult` added to `LeagueProvider` + implemented for ESPN (the real
`scoringPeriodId`-on-the-fetch fix); Sleeper/Yahoo throw a clear
not-yet-supported error. `src/tracking/store.ts` (append-only per-season
JSON log, `data/tracking/<season>.json`) + `src/tracking/collect.ts`
(`buildSnapshot` pure, `recordSnapshot` wraps it with the disk write + a
"never throws" guard). Wired into `set-lineup.ts` and `server/data.ts` —
every computed plan gets logged, CLI or dashboard, submitted or not.
`docker-compose.yml` got a new `tracking-data` volume, separate from
`app-cache`. 201 unit tests pass. Verified live: a real `npm run lineup`
run wrote a real snapshot to disk, and `provider.getWeekResult(1)` through
the actual ESPN provider correctly returned A.J. Brown's true week-1
starting WR slot (with that week's real 5-point score) — distinct from his
current IR slot, proving the historical-week fetch genuinely works and
isn't just echoing current state.

Not yet built: grading (phase 2), the CLI report (phase 3), the dashboard
panel (phase 4). No data exists to grade against yet regardless — that
starts accumulating from this point forward.

## Problem

The optimizer recommends a lineup every week, but nothing remembers what it
said or checks whether it was right. The ask: log what the tool recommended,
compare it against what actually got played, and build a season-long record
of accuracy — a hit rate, and how many points following (or not following)
the call actually cost.

Confirmed with the user (via AskUserQuestion):
- **Which snapshot counts as "the call"**: recommendations get logged every
  time `npm run lineup` or the dashboard computes a plan; for grading, use
  the **most recent snapshot taken before that week's first player lock** —
  the freshest advice the tool could have given before any result could bias
  it.
- **What counts as "actually played"**: pulled automatically from ESPN once
  the week is over — your true final lineup, regardless of whether it was
  set through this tool or the ESPN app directly. No manual input.
- **Where it's surfaced**: a dashboard panel (CLI report optional/cheap to
  add alongside it, given every other dashboard view already has one).

## Key technical finding

ESPN's `mRoster` view returns **true historical lineup-slot data** when you
pass `scoringPeriodId` explicitly in the request — confirmed live: querying
week 1 (after A.J. Brown moved to IR in a later week) correctly returned his
week-1 slot as a starting WR, not his current IR slot. This is what makes
"pull the actual lineup automatically" possible at all.

However, **`EspnLeague.getRoster(week)` doesn't currently use this** — it
only passes `week` through to `mapRosterEntry` for picking which stat row to
read (projection/actual points); the roster *fetch itself* never sends
`scoringPeriodId`, so `entry.lineupSlotId` (→ `Player.currentSlot`) always
reflects the **current** slot, not the requested week's historical one. This
needs fixing as part of this feature, not just reused as-is.

## Scope

**In**: ESPN only (matches the "ESPN only for now" precedent already set by
`locked`/`kickoffAt`/`livePoints`). Snapshot recording on every `npm run
lineup` / dashboard lineup load. A grading pass once a week's games are
complete. A season-to-date report (CLI + dashboard panel).

**Out**: Sleeper/Yahoo historical pull (revisit later if the user switches
providers); grading a week that isn't fully complete yet (partial-week
scores would be misleading — show "in progress" instead); editing/annotating
past recommendations by hand.

## Approach

### 1. Provider capability — `getWeekResult(week)`

Add to `LeagueProvider` (`src/providers/types.ts`):

```ts
/** The true historical roster/lineup-slot state for a completed past week,
 *  plus that week's actual (not projected) points. ESPN only for now —
 *  other providers may throw "not supported". */
getWeekResult(week: number): Promise<RosterReadResult>;
```

`EspnLeague.getWeekResult(week)` fetches `mRoster`+`mSettings` **with
`scoringPeriodId: week` in the request params** (the fix above), and maps
entries the same way `getRoster` does, so `currentSlot` reflects that week's
real assignment and `projectedPoints`/`livePoints` reflect that week's real
stat rows. Sleeper/Yahoo throw a clear "not supported" error.

### 2. Recording snapshots — `src/tracking/store.ts` (new, impure)

Append-only, one JSON array file per season: `data/tracking/<season>.json`,
entries shaped:

```ts
interface Snapshot {
  week: number;
  fetchedAt: string; // ISO
  assignments: { slotCode: string; playerId: string; playerName: string }[];
}
```

`appendSnapshot(dataDir, season, snapshot)` and `readSnapshots(dataDir,
season)`. Deliberately NOT under `.cache/` — this is real history the user
cares about, not disposable derived data; a "clear the cache" instinct
should never touch it. New top-level `data/` directory, gitignored, with its
own Docker volume (`tracking-data:/app/data`) — separate from `app-cache` so
nothing else ever competes for or accidentally prunes it.

### 3. Grading — `src/tracking/grade.ts` (new, pure)

```ts
/** The snapshot to grade: the latest one strictly before firstLockAt. */
export function selectRecommendedSnapshot(
  snapshots: readonly Snapshot[],
  firstLockAt: string,
): Snapshot | undefined;

export interface WeekGrade {
  week: number;
  recommendedTotal: number;
  actualTotal: number;
  delta: number; // actual - recommended; negative = left points on the table
  slotAgreement: { slotCode: string; recommended: string; actual: string; agreed: boolean }[];
  agreementRate: number; // fraction of slots where actual matched recommended
}

export function gradeWeek(
  recommended: Snapshot,
  actual: RosterReadResult, // from getWeekResult, real slots + livePoints
): WeekGrade;

export interface SeasonSummary {
  weeks: WeekGrade[];
  avgAgreementRate: number;
  avgDelta: number;
  weeksRecommendationWasBetter: number;
  weeksActualWasBetter: number;
}
export function summarizeSeason(weeks: readonly WeekGrade[]): SeasonSummary;
```

`firstLockAt` for a week = `min(kickoffAt)` across everyone in that week's
recommended snapshot, reusing `fetchKickoffTimes`/`attachKickoffTimes`
(`src/lineup/kickoff.ts`) already built for the flex tie-break — no new
kickoff-time plumbing needed.

### 4. Orchestration — `src/tracking/collect.ts` (new, impure)

- `recordSnapshot(config, plan)` — called from `set-lineup.ts` and
  `server/data.ts` every time a plan is computed (read-only views included,
  not just real submits — the recommendation existed the moment it was
  shown, whether or not it was acted on).
- `buildSeasonReport(config)` — for every past week with recorded snapshots:
  fetch `getWeekResult(week)`, skip weeks not yet fully complete (any
  starter's `kickoffAt` still in the future, or `livePoints` data absent),
  `selectRecommendedSnapshot` + `gradeWeek`, then `summarizeSeason`.

### 5. Surfacing it

- **CLI**: `npm run track:review` (mirrors `draft:review`'s pattern) —
  prints the week-by-week table + season summary.
- **Dashboard**: new `GET /api/tracking` (`server/data.ts`,
  `getTrackingView`) + a third panel in `public/index.html`/`app.js`
  showing the same table, read-only, refresh button matching the other two
  panels.

## Files

| File | Change |
| --- | --- |
| `src/providers/types.ts` | `getWeekResult(week)` on `LeagueProvider` |
| `src/providers/espn/EspnLeague.ts` | implement it (real fix: pass `scoringPeriodId`) |
| `src/providers/sleeper/SleeperLeague.ts`, `src/providers/yahoo/YahooLeague.ts` | throw "not supported" |
| `src/tracking/store.ts` | new — snapshot persistence |
| `src/tracking/grade.ts` | new — pure grading/summary |
| `src/tracking/collect.ts` | new — orchestration |
| `src/cli/set-lineup.ts`, `src/server/data.ts` | call `recordSnapshot` |
| `src/cli/track-review.ts` | new — `npm run track:review` |
| `src/server/data.ts` | `getTrackingView` |
| `public/index.html`, `public/app.js` | third panel |
| `docker-compose.yml` | `tracking-data` volume |
| `package.json` | `track:review` script |
| `tests/tracking-grade.spec.ts`, `tests/tracking-store.spec.ts` | new |

## Verification

1. `npm run typecheck`, `npm run test:unit`.
2. Live: confirm `getWeekResult(1)` returns week 1's real historical slots
   (already spot-checked manually — A.J. Brown's week-1 slot correctly
   differs from his current IR slot).
3. Run `npm run lineup`/load the dashboard a few times across a week to
   confirm snapshots accumulate in `data/tracking/<season>.json`.
4. Once a week completes, `npm run track:review` and the dashboard panel
   should agree on the same grade for that week.

## Notes / open items

- First season of data will be thin (recommendation history only starts
  once this ships) — the report should say so plainly for weeks with no
  snapshot, rather than silently omitting them.
- "Agreement rate" only checks slot-for-slot player identity, not whether a
  swap was actually reachable (e.g., a player added off waivers mid-week
  wasn't in any snapshot yet) — worth a caveat in the report output.
