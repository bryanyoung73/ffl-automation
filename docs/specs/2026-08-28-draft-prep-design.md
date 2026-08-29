# Draft prep: override analysis

Date: 2026-08-28
Status: approved

## Problem

If you set no custom pre-draft rankings, Yahoo's live draft follows its **default
pre-rank** (Yahoo's expert ranking) for your queue and for autodraft. The value
is not in rebuilding a 200-player board — it's in finding the specific spots
where Yahoo's default is out of line with independent signal, so you override
only the handful that matter (or discover the list is fine and leave it alone).

## Scope

**In:** Scrape Yahoo's default pre-rank, ADP, season projections, and league
settings. Compute an independent value ranking (VOR). Diff the orderings. Emit an
override sheet + a plain-English verdict. Read-only against Yahoo.

**Out (later, own specs):**
- Pushing overrides back to `editprerank` (feature C — DOM-dependent).
- Live draft-day pick assistant (feature D).
- FantasyPros ECR provider (stubbed now, implemented as a fast-follow).
- Auction dollar values (snake assumed).

## Approach

Yahoo-only analysis with a pluggable `SignalProvider` interface. Pure-logic core
(VOR, diff, report) with no Playwright imports, unit-tested against synthetic
data. Scrapers follow the existing `LineupPage` pattern: all selectors in one
object, `artifacts/` HTML+screenshot dump on a miss. Selectors are best guesses
until verified against the real logged-in pages.

## Modules

```
src/draft/
  types.ts               Position, LeagueSettings, PlayerRef, PlayerProjection,
                         PlayerSignals, Override, CheatSheet
  vor.ts                 PURE: projections + settings -> { vor, vorRank } per player
  diff.ts                PURE: yahooRank + signal ranks -> ranked Override[]
  report.ts              PURE: CheatSheet -> markdown + csv + console summary
  signals/
    types.ts             SignalProvider interface
    fantasyPros.ts       stub (throws "not implemented")
src/pages/
  LeagueSettingsPage.ts  scrape roster slots + scoring from /f1/<id>/settings
  DraftRankingsPage.ts   scrape default pre-rank order + ADP
  ProjectionsPage.ts     scrape season projected points
src/cli/
  cheatsheet.ts          npm run cheatsheet
tests/
  vor.spec.ts  diff.spec.ts  report.spec.ts        pure, no browser
  draft-rankings-page.spec.ts                      live, auto-skips w/o session
```

## Data acquisition

Keyed by Yahoo player id throughout.

| Source | URL (approx) | Yields |
| --- | --- | --- |
| League settings | `/f1/<league>/settings` | teams, scoring (PPR weight), starting slots, bench size, draft type |
| Default pre-rank | `/f1/<league>/<team>/editprerank` | ordered `[{rank, id, name, pos, team, bye}]` |
| ADP | `/f1/<league>/draftanalysis` | `{id: adp}` |
| Projections | `/f1/<league>/players` w/ season-projected stat filter | `{id: projectedPoints}` |

Selectors finalized against real pages after first login.

## VOR core (pure)

Replacement level is computed by simulation, so flex is handled correctly:

1. Sort all projected players by points desc.
2. Fill league-wide starting slots greedily: `teams` copies of each dedicated
   slot (QB, RB, WR, TE, K, DEF), then `teams` copies of each FLEX slot from the
   best remaining RB/WR/TE.
3. `replacementPoints[pos]` = projection of the best player at `pos` who did
   **not** receive a starting slot.
4. `VOR = projectedPoints - replacementPoints[pos]`; rank by VOR desc.

Positions with fewer players than league starter demand → replacement = 0.

## Diff core (pure)

Inputs: `PlayerSignals[]` (each: `yahooRank` + a map of available signal ranks —
`adp`, `vor`, later `ecr`), `threshold` (default 10), optional position filter.

Per player:
- `consensusRank` = mean of available signal ranks.
- `delta = yahooRank - consensusRank`. Positive → Yahoo ranks him too low →
  **undervalued** (draft earlier). Negative → **overvalued** (let him slide).
- `tierOf(rank) = ceil(rank / teams)` — snake round bucket.
- Flag as an override candidate when `abs(delta) >= threshold`
  **or** `tierOf(yahooRank) !== tierOf(consensusRank)`.

Sort candidates by `abs(delta)` desc. Partition into undervalued / overvalued.

## Report core (pure)

`CheatSheet -> { markdown, csv, summary }`.

- Markdown: verdict line, then two tables (undervalued, overvalued) sorted by
  `|delta|`, columns Player / Pos / Team / Bye / Yahoo / Consensus / Δ / ADP /
  VOR / (ECR).
- CSV: one flat row per override.
- Console: verdict + top 10 by `|delta|`.

Verdict:
- 0 candidates → "Yahoo's default pre-rank is solid — no custom ranking needed."
- 1–8 → "Minor tweaks: override the N players below."
- 9+ → "Worth building a custom pre-rank — N meaningful gaps."

## CLI

```
npm run cheatsheet                     full run -> artifacts/cheatsheet-<date>.{md,csv}
npm run cheatsheet -- --threshold 15   stricter override bar
npm run cheatsheet -- --pos RB         restrict analysis to one position
```

New `.env`: `DRAFT_OVERRIDE_THRESHOLD=10`.

## Testing

- `vor.spec.ts` — replacement-level simulation: flex allocation, scarce
  positions, K/DEF, ties.
- `diff.spec.ts` — delta sign/direction, tier-crossing trigger, threshold
  trigger, position filter, consensus with partial signals.
- `report.spec.ts` — verdict thresholds, table partitioning, CSV shape.
- `draft-rankings-page.spec.ts` — live: scrape returns a non-empty ordered list
  with byes; auto-skips without `.auth/storageState.json`.

## Follow-ups

1. Feature C — push the override sheet to `editprerank`.
2. `fantasyPros.ts` — real ECR provider.
3. Feature D — live draft assistant (own spec).
