# Waiver wire: who to add, who to drop

Date: 2026-09-03
Status: Phase 1 shipped; phases 2–4 not started

## Problem

In-season, the weekly grind after setting a lineup is the waiver wire: scan the
free agents, decide if any of them beats the worst player on your roster, and if
so, who to drop. Doing it well means blending rest-of-season upside, this
week's matchup, and the same chatter/injury signal the lineup optimizer already
uses. Nothing in the repo does this yet, but almost every piece it needs is
already built.

## Scope

**In:** A `npm run waivers` command (ESPN first) that produces ranked **add /
drop pairs** with reasoning:
- rank the available free agents by a blended value (rest-of-season + this week
  + waiver buzz)
- rank your own bench by the same value → drop candidates, with protection
  rules (don't suggest dropping an IR stash, your only backup at a thin
  position, a bye-week starter, or a rising young player)
- pair each worthwhile add with its best legal drop; only surface the pair when
  the value gain clears a margin (no churn for +0.3)
- a short **streaming** list for DEF / K (and QB in shallow leagues) driven by
  Vegas matchup

**Out (later phases or separate specs):** FAAB bid sizing, waiver-priority
strategy, trade targets, Yahoo free-agent support (ESPN is where the league
is), multi-week "hold vs stream" planning.

## Reuse — this is mostly wiring

| Need | Existing piece |
| --- | --- |
| Free-agent list + weekly/season projections | new `getFreeAgents()` on `LeagueProvider`, same `kona_player_info` shape as `getDraftBoard` |
| Your roster + bench | `provider.getRoster()` |
| Intel-adjust every projection | `intel/weekly.ts` `applyWeeklyIntel` / `adjustProjections` |
| Waiver buzz | `intel/collect.ts` — Sleeper **trending adds** is the canonical signal here; ESPN news; Sleeper depth-chart (role changes drive pickups) |
| Streaming matchup value | `intel/providers/vegas.ts` (implied totals, weather) |
| "Who never starts" → drop candidate | `lineup/optimizer.ts` `optimizeLineup` |
| Positional replacement value for the ROS score | `draft/vor.ts` `computeVor` |
| Identity join for intel | `intel/match.ts` / `nfl/names.ts` |
| Consensus rank where projections are thin | `draft/ecr.ts` (ROS ranking as a fallback) |

## Approach

### 1. Value model — `src/waivers/value.ts` (pure)

For every player (FA pool **and** your roster), compute:

- **`rosVal`** — rest-of-season points above positional replacement. From ESPN's
  season projection minus points already scored (games elapsed), VOR-adjusted
  via `computeVor` over the FA-pool + rostered players. This is the "is he
  worth a roster spot" number.
- **`weekVal`** — this week's projected points, run through `adjustProjections`
  (`horizon: "week"`) so injury/practice/Vegas move it.
- **`buzz`** — a small boost from `ownership.percentChange` (rostered % rising
  fast) + Sleeper trending-add rank. Captures "a role just opened up."
- **`blended`** — `rosVal * w + weekVal * (1-w) + buzz`, with `w` from a
  `--ros` / `--win-now` toggle (default leans ROS).

Pure: `valuePlayers(players, projections, intel, settings, opts) → Map<id, PlayerValue>`.

### 2. Pairing — `src/waivers/pairs.ts` (pure)

```
buildAddDrops(faValues, rosterValues, roster, settings, opts) → WaiverReport
```

- Sort FAs by `blended` desc → add candidates. Tag each `FREEAGENT` (instant) or
  `WAIVERS` (bid).
- Sort roster bench by `blended` asc → drop candidates, minus **protected**:
  - currently in an IR slot
  - the only rostered backup at a position where you start ≥ 2 and have ≤ 2
  - on a bye this week but a starter otherwise
  - `intel.seasonImpact > 0` (trending up) or a young "role still projecting"
    note
- For each add, best drop = lowest-value unprotected roster player the add is
  slot-eligible to replace. Emit the pair when
  `add.blended - drop.blended >= opts.margin` (default ≈ one start-worthy
  point of ROS value).
- **Streaming**: separate pass for DEF / K — rank FAs at those spots by
  `weekVal` (Vegas-heavy: DEF wants a low opponent implied total, K wants a
  high team total + good weather), pair against your current DEF/K only when
  the week delta clears a smaller margin.

### 3. CLI — `src/cli/waivers.ts`

```
npm run waivers
npm run waivers -- --win-now         # weight this week over ROS
npm run waivers -- --pos RB          # one position
npm run waivers -- --limit 5         # top N add/drop pairs
npm run waivers -- --no-llm / --llm  # same intel flags as roster/lineup
npm run waivers -- --csv             # write output/waivers-<date>.csv
```

Output: for each pair, add line (value breakdown + top intel note + rostered%),
drop line (value + why it's the drop), and the net ROS/week delta. A "nothing
worth adding at X — your bench is stronger than the pool" line per position with
no recommendation. Streaming block last.

## Modules

```
src/waivers/
  types.ts        PlayerValue, WaiverCandidate, AddDropPair, WaiverReport
  value.ts        PURE  valuePlayers(...)
  pairs.ts        PURE  buildAddDrops(...) + streaming + protection rules
src/providers/
  types.ts             + getFreeAgents(week?): Promise<FreeAgent[]>
  espn/EspnLeague.ts   kona_player_info + x-fantasy-filter filterStatus
                       ["FREEAGENT","WAIVERS"]; map like the draft board +
                       weekly/season projections + ownership.percentChange
  yahoo/YahooLeague.ts throw NOT_SUPPORTED for now
src/cli/waivers.ts     npm run waivers
tests/
  waiver-value.spec.ts   replacement math, ROS-from-season, buzz, blend weight
  waiver-pairs.spec.ts   protection rules, slot-eligible pairing, margin gate,
                         streaming, "bench stronger than pool"
```

## Phases

1. **Core add list + drop pairing** against ESPN — value model, protection
   rules, `npm run waivers`. (~2 days)
2. **Streaming module** for DEF/K/QB, Vegas-driven. (~0.5 day)
3. **FAAB bid suggestion** — % of budget scaled by the value delta and how
   contested the add is (rostered-% momentum). (~0.5 day)
4. **Yahoo free-agent scrape.** (~1 day, only if still wanted)

## Testing

- `waiver-value.spec.ts` — ROS = season proj − points scored so far; VOR
  replacement over FA + roster pool; buzz scales with rostered-% change; the
  `--win-now` weight actually shifts the blend.
- `waiver-pairs.spec.ts` — an IR stash / lone backup / bye starter / rising
  rookie is never a drop; an add only pairs with a slot-eligible drop; a
  sub-margin upgrade is suppressed; streaming pairs on `weekVal` only; a
  position whose bench beats the pool yields the "nothing worth adding" line.
- Provider fetch stays out of CI — a captured FA-list fixture feeds the pure
  functions, same pattern as `espn-league.spec.ts`.

## Addendum — Phase 1 shipped (2026-09-03)

Built: `src/waivers/{types,value,pairs}.ts`, `src/cli/waivers.ts`
(`npm run waivers`), `LeagueProvider.getFreeAgents()` (ESPN:
`kona_player_info` + `filterStatus ["FREEAGENT","WAIVERS"]`, mapped like the
draft board + `mapFreeAgent`), Yahoo throws `NOT_SUPPORTED`. `Player` gained
optional `seasonProjectedPoints` / `pointsSoFar`; `mapRosterEntry` fills them.
`--win-now` / `--pos` / `--limit` / `--csv` / `--llm` / `--no-intel` /
`--refresh`. `tests/waiver-{value,pairs}.spec.ts` — 12 new tests.

**ROS projection** — confirmed: ESPN gives no rest-of-season total. `stats`
carries `src=1/split=0/season=<year>` (full-season projection) and
`src=0/split=0/season=<year>` (actual so far). `actualSeasonPoints()` added;
`rosProjection = max(0, seasonProj − actualSoFar)`.

**Superflex fix** (found while building this) — ESPN lineup slot `7` was mapped
to `"W/R/T"`, so every QB (tagged OP-eligible) looked flex-eligible and could
be paired as a drop for an RB add, or slotted into FLEX by the optimizer. Slot
7 now maps to `"OP"`; `pairs.ts` only treats two players as competing for a
flex role when the league actually starts that flex slot.

Not live-verified end to end — the ESPN league is undrafted (empty roster). The
FA fetch and the full value → pairs → render pipeline were exercised against a
synthetic roster built from the FA pool; unit tests cover the pure logic.

## Open items (phases 2+)
- **Roster locks** — skip drop suggestions for players whose game has started;
  low priority.
- **Standings-aware default** — a 1–5 team should default to `--win-now`, a 5–1
  team to ROS. Needs `getStandings()` / team record; phase 2+.
- **Add margin tuning** — start conservative; an `--aggressive` flag loosens the
  gate and the protection rules.
