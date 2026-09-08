# Sleeper provider — a third back end with a real live draft feed

Date: 2026-09-08
Status: phase 1 shipped (2026-09-08) — see addendum. Live verification pending a
real Sleeper league id / mock draft.

## Problem

On 2026-09-07, mid-draft, we confirmed ESPN's read API does **not** carry live
picks: `mDraftDetail` stays a skeleton of empty slots and team rosters stay
empty until the draft *completes*. ESPN's draft room is websocket-only. The live
draft assistant (`npm run draft`) was dead on arrival for an ESPN live draft and
only works after the fact.

Sleeper is the opposite: a fully public REST API, **no auth for reads**, and
`GET /draft/<id>/picks` updates in real time as picks are made. Adding Sleeper
as a third `LeagueProvider` resurrects the live draft assistant — the entire
engine (`computeAdvice`, survival, tier cliffs, runs, VONA, ceiling/floor, the
recorder) is provider-agnostic and needs no changes.

The repo already depends on Sleeper: `src/intel/match.ts` loads the
`/players/nfl` dump for cross-provider identity. A Sleeper provider reuses that
as its primary player source.

## Scope

**In (phase 1):**
- `PROVIDER=sleeper` → `SleeperLeague` implementing the read side of
  `LeagueProvider`:
  - `getLeagueSettings()` — teams, scoring, starters, bench, draft type
  - `getDraftState()` — live picks, status, **and my draft slot** (Sleeper
    assigns it up front, so no `--slot` guessing)
  - `getDraftBoard()` — the player universe from the Sleeper dump, ordered by a
    new FantasyPros **ADP** scrape (`draft/adp.ts`, sibling to `ecr.ts`)
- `npm run draft` (poll loop, unchanged) works live on a Sleeper draft, incl.
  `--record` → `npm run draft:review`.

**Out (later phases):**
- Phase 2 — FantasyPros season projections scrape → VOR on Sleeper boards
  (parity with ESPN).
- Phase 3 — `getRoster()` / `getFreeAgents()` (needs weekly projections;
  another FP scrape) → `npm run roster` / `npm run waivers` on Sleeper.
- Phase 4 — `applyLineup()` writes (needs a Sleeper auth token).

Until then those four methods `throw NOT_SUPPORTED`, same as Yahoo's
`getFreeAgents` / `getDraftState`.

## Reuse

| Need | Existing piece |
| --- | --- |
| Provider contract | `LeagueProvider` (`src/providers/types.ts`) — unchanged bar an optional `DraftState.mySlot` |
| Board pipeline | `assembleBoard` + `buildBoard` — Sleeper just supplies a different `getDraftBoard` |
| Live draft engine | `src/draft/live/*` — **zero changes** |
| Recorder / calibrator | `record.ts` / `calibrate.ts` — unchanged |
| Player identity dump | `loadSleeperPlayers` (`src/intel/match.ts`) — already fetched + cached 24h |
| Scrape + cache pattern | `src/draft/ecr.ts` + `cachedParsed` (`src/intel/cache.ts`) — `adp.ts` clones it |
| HTTP-client shape | `src/providers/espn/client.ts` (`EspnClient`) — `SleeperClient` is a simpler sibling (no cookies, no filter header) |
| Poll loop + `noCache` | `src/cli/draft.ts` + `EspnClient.get({noCache})` pattern |

## Approach

### 1. Config — `src/config.ts`

`PROVIDER` accepts `"sleeper"`. New `SleeperConfig`:

```ts
interface SleeperConfig {
  leagueId: string;      // SLEEPER_LEAGUE_ID (required)
  userId: string | null; // SLEEPER_USER_ID, or resolved from SLEEPER_USERNAME
  username: string | null;
  season: number;        // SLEEPER_SEASON, default current year
  baseUrl: string;       // https://api.sleeper.app/v1
}
```

No secrets — reads are public. `userId` identifies "my" roster / draft slot; it
can be resolved lazily from `username` via `GET /user/<username>` on first use,
so `SLEEPER_USER_ID` is optional if `SLEEPER_USERNAME` is set. For a pure draft
board neither is strictly required, but the live assistant wants one to know
which picks are mine.

### 2. `SleeperClient` — `src/providers/sleeper/client.ts`

Thin `fetch` wrapper: `get<T>(path, { noCache? })`, base URL, JSON parse,
per-process GET memo (keyed by path), `noCache` bypass for the picks poll.
Non-2xx → `Error` with status + path. 404 on `/user/<username>` → friendly
"check SLEEPER_USERNAME". No auth headers.

### 3. Player source

Reuse `loadSleeperPlayers(cacheDir)` from `match.ts` (the `/players/nfl` dump,
`player_id → { full_name, position, team, fantasy_positions, ... }`, 24h cache).
Add a small `playerUniverse()` helper: filter to fantasy-relevant positions
(`QB RB WR TE K DEF` + IDP if the league uses them), drop inactive/practice-squad
where the dump flags it, keep DEF entries (Sleeper keys those by team abbr, e.g.
`"KC"`).

### 4. `mapSettings` — pure

`GET /league/<id>`:
- `settings.num_teams` (fallback `total_rosters`) → `teams`
- `scoring_settings.rec` → `0` standard / `0.5` half-ppr / `1` ppr
- `roster_positions: string[]` → `starters`, via a slot-code map:
  `QB RB WR TE K DEF` → same; `FLEX` → `W/R/T`; `SUPER_FLEX` → `OP`;
  `REC_FLEX` → `W/T`; `IDP_FLEX`/`DL`/`LB`/`DB` → IDP codes; `BN` counted for
  `benchSize`; `TAXI`/`IR` skipped.
- draft type from `GET /draft/<draft_id>` `type` (`snake` / `linear` /
  `auction`) — `linear` maps to `snake` for our purposes (turn math differs;
  note it).

### 5. `getDraftState` — pure mapper + fetch

- `GET /league/<id>/drafts` → newest `draft_id` (or `league.draft_id`).
- `GET /draft/<draft_id>` → `status` (`pre_draft` / `drafting` / `complete` /
  `paused`), `draft_order: { user_id: slot }`, `slot_to_roster_id`,
  `settings.rounds`. → `mySlot` = `draft_order[userId]`; `myRosterId` =
  `slot_to_roster_id[mySlot]`.
- `GET /draft/<draft_id>/picks` **(noCache)** →
  `[{ pick_no, round, roster_id, player_id, picked_by, draft_slot }]` →
  `DraftPick[]` (`pick_no` → `overall`, `roster_id`/`draft_slot` → `teamId`,
  `player_id` → `playerId`, keeper via `is_keeper`). Sorted by `pick_no`.

`DraftState` gains `mySlot?: number | null` (Sleeper fills it; ESPN/Yahoo
leave it undefined). `draft.ts`: `mySlot = state.mySlot ?? flag ?? autodetect`.

### 6. `getDraftBoard` — ADP from FantasyFootballCalculator

Sleeper exposes no ADP or projections through the league API. Recon (2026-09-08)
settled the source: **FantasyFootballCalculator's public JSON API**, not a
FantasyPros scrape.

```
GET https://fantasyfootballcalculator.com/api/v1/adp/<ppr|half-ppr|standard>?teams=<n>&year=<season>
→ { players: [{ name, position, team, adp, adp_formatted, high, low, stdev, bye, times_drafted }] }
```

No auth, clean JSON, `teams=` scales the ADP to the league size, ~5k recent
drafts, updated daily. It carries three fields the ESPN board never had:

- `high` / `low` — best / worst actual draft slot → **draft-position ceiling /
  floor** (complements the ECR-rank ceiling/floor just shipped)
- `stdev` — real observed draft variance → the per-player σ the survival model
  currently *guesses* with `clamp(adp·0.15, 4, 18)` (see the room-read spec)

**`src/draft/adp.ts`** (pure `parseAdp` / `attachAdp`, impure `fetchAdp` with an
8h `cachedJson`) — mirrors `ecr.ts`. `attachAdp(entries, adp)` joins by
normalized name (+ team tiebreak) and sets `adp`, `adpHigh`, `adpLow`,
`adpStdev` on the entry.

`getDraftBoard()` = `playerUniverse()` → `BoardEntry`
(id/name/position/team/bye from the dump) → `attachAdp` → ordered by `adp`.
`xRank` / `projectedPoints` null in phase 1 (VOR arrives in phase 2). ECR still
layers on in `assembleBoard` and is the expert baseline.

`BoardEntry` / `BoardRow` gain `adpHigh? / adpLow? / adpStdev?`
(`number | null`); `willLast` gets an optional `sigmaOverride` so a real
`adpStdev` beats the heuristic when present. FFC ADP is also a candidate
enrichment for the **ESPN** board (it has no `high/low/stdev`).

### 7. Unsupported (phases 3–4)

`getRoster` / `getFreeAgents` / `applyLineup` → `throw new Error("… is
Sleeper-only from phase 3; needs a weekly-projections source. …")`.

### 8. Wiring

- `src/providers/index.ts` — `case "sleeper": return new SleeperLeague(config)`;
  `providerLabel` → `"Sleeper"`.
- `src/providers/types.ts` — `DraftState.mySlot?: number | null`.
- `src/cli/draft.ts` — prefer `state.mySlot` for the slot; `--slot` overrides.

## Config (`.env`)

| Var | Default | Notes |
| --- | --- | --- |
| `PROVIDER` | `yahoo` | now also `sleeper` |
| `SLEEPER_LEAGUE_ID` | — | from the league URL `sleeper.com/leagues/<id>` — required |
| `SLEEPER_USERNAME` | — | your Sleeper handle; resolved to a user id on first use |
| `SLEEPER_USER_ID` | — | set instead of the username to skip the lookup |
| `SLEEPER_SEASON` | current year | e.g. `2026` |

No tokens or cookies.

## Modules

```
src/providers/sleeper/
  client.ts        SleeperClient — fetch wrapper, GET memo, noCache
  maps.ts          PURE  slot-code map, scoring detect, pick + settings mappers
  SleeperLeague.ts LeagueProvider impl + exported pure mappers
src/draft/
  adp.ts           PURE parseAdp / attachAdp  +  fetchAdp (FFC JSON API, 8h cache)
src/providers/
  types.ts         + DraftState.mySlot?: number | null
  index.ts         + "sleeper" case
src/config.ts      + SleeperConfig, PROVIDER="sleeper"
src/cli/draft.ts   prefer state.mySlot for the draft slot
tests/
  sleeper-maps.spec.ts     fixtures -> settings / picks / mySlot; slot-code map
  sleeper-league.spec.ts   full league+draft fixture -> DraftState, board order
  adp.spec.ts              parseAdpHtml on a captured snippet; attachAdp join
  fixtures/sleeper-*.json  captured /league, /draft, /draft/picks, dump subset
```

## Phases

1. **Live draft on Sleeper** — config, `SleeperClient`, `maps.ts`,
   `SleeperLeague` (settings + draft state + ADP-ordered board), `draft/adp.ts`,
   `DraftState.mySlot`, wiring, fixtures + tests. `npm run draft` works live.
   (~2–3 days)
2. **VOR** — `draft/projections.ts` FantasyPros season-projection scrape,
   wired into `getDraftBoard` (and available to the ESPN board as a cross-check).
   (~1 day)
3. **Roster + waivers** — `getRoster` from `/league/<id>/rosters` + a weekly
   FP-projection scrape; `getFreeAgents` from the dump minus rostered.
   `npm run roster` / `waivers` on Sleeper. (~2 days)
4. **Writes** — `applyLineup` via Sleeper's authenticated API (needs a token in
   `.env`). Only if wanted. (~1 day)

## Testing

- Pure mappers against captured fixtures, same pattern as `espn-league.spec.ts`
  — no network in CI.
- `adp.spec.ts` — `parseAdp` against a captured FFC JSON response; `attachAdp`
  name-join incl. a suffix/defense edge.
- **Live check needs a real Sleeper league id.** Sleeper **mock drafts** are
  perfect for this: free, instant, and they exercise the exact live pick feed
  (`/draft/<id>/picks` updating in real time). Create a mock league, run
  `npm run draft --record`, watch picks land, then `npm run draft:review`.
- Sleeper's rate limit is ~1000 req/min; polling every 3–5 s is ~15/min — no
  concern.

## Addendum — Phase 1 shipped (2026-09-08)

Built:

- `src/config.ts` — `PROVIDER=sleeper`, `SleeperConfig` (`leagueId`,
  `userId`/`username`, `season`, `baseUrl`). No secrets.
- `src/providers/sleeper/client.ts` — `SleeperClient`: fetch wrapper, per-process
  GET memo, `noCache` for the picks poll, friendly 404.
- `src/providers/sleeper/maps.ts` (pure) — `detectScoring` (`scoring_settings.rec`),
  `mapSettings` (roster_positions → starters incl. `FLEX`→`W/R/T`,
  `SUPER_FLEX`→`OP`; BN→benchSize; IR/TAXI skipped), `mapDraftState`
  (status → drafted/inProgress; picks sorted; **`mySlot`** from
  `draft_order[userId]`, **`myTeamId`** from `slot_to_roster_id`),
  `playerUniverse` (dump → BoardEntry, offense+DEF, DEF id'd by team code).
- `src/providers/sleeper/SleeperLeague.ts` — `getLeagueSettings` /
  `getDraftState` / `getDraftBoard`; the other three throw NOT_SUPPORTED.
- `src/draft/adp.ts` (pure `parseAdp` / `attachAdp`, impure `fetchAdp`) —
  FantasyFootballCalculator `/api/v1/adp` JSON, 8h cache. `BoardEntry` /
  `BoardRow` gained `adpHigh` / `adpLow` / `adpStdev`; `buildBoard` carries them.
- `src/draft/live/survival.ts` — `willLast(adp, next, sigmaOverride?)`; a real
  `adpStdev` (clamped 1–25) beats the `clamp(adp·0.15, 4, 18)` heuristic.
  `computeAdvice` + `computeVona` pass `row.adpStdev`.
- `src/providers/{types,index}.ts` — `DraftState.mySlot` / `myTeamId`;
  `"sleeper"` case + label.
- `src/cli/draft.ts` — allows `PROVIDER=sleeper`; prefers `state.mySlot` /
  `state.myTeamId` (so `npm run draft` needs no `--slot` on Sleeper);
  provider-agnostic log filename.
- `tests/sleeper-maps.spec.ts` (5) + `tests/adp.spec.ts` (3). Typecheck clean,
  173 unit tests pass.

**Verified against real data** (no league id needed): the Sleeper `/players/nfl`
dump (12,226) → `playerUniverse` (878 offense+DEF) → FFC ADP (255) →
`attachAdp` matched **254**, board correctly ADP-ordered with real
`high`/`low`/`stdev` and byes. Gibbs σ0.6 vs James Cook σ2.8 — the per-player
survival sigma the model wanted.

## Addendum — mock-draft support (2026-09-08)

A mock draft has **no league** (`league_id: null`); its roster shape lives in
the draft object's `settings.slots_*` and scoring in `metadata.scoring_type`.
Added:

- `SLEEPER_DRAFT_ID` config — an alternative to `SLEEPER_LEAGUE_ID` (one
  required). `SleeperLeague.draftId()` short-circuits to it; `league()` is never
  called.
- `mapSettingsFromDraft(draft)` (pure) — `slots_qb/rb/wr/te/k/def/flex/
  super_flex/…` → starters, `slots_bn` → bench, `scoring_type`
  (`ppr`/`half_ppr`/`std`, default `ppr`) → scoring. `mapSettings(null, draft)`
  delegates to it, and so does the league path when `roster_positions` is
  empty.
- `getDraftBoard` derives scoring/teams via `getLeagueSettings` (handles both).
- `env.example` + docs.

`tests/sleeper-maps.spec.ts` +2. **Verified live** against a real Sleeper draft
via `SLEEPER_DRAFT_ID` alone: `getLeagueSettings` → `8-team ppr, 2 flex, 5
bench` from the draft's slots; `getDraftState` → 120 picks mapped;
`SLEEPER_USERNAME` → `mySlot` / `myTeamId` resolved from `draft_order` /
`slot_to_roster_id`, and `npm run draft --once` rendered that user's real
roster. 175 unit tests pass.

## Addendum — Phase 2 shipped (2026-09-08)

VOR on Sleeper boards — **from Sleeper's own projections API, not a FantasyPros
scrape** (a strict improvement: no HTML, exact id join, scoring-matched).

- `src/providers/sleeper/projections.ts` — `parseProjections(raw, scoring)`
  (pure) reads `stats.pts_ppr` / `pts_half_ppr` / `pts_std` keyed by
  `player_id`; `fetchSleeperProjections(cacheDir, season, scoring)` hits
  `api.sleeper.com/projections/nfl/<season>?season_type=regular&position[]=…`
  (note `.com`, separate host, no `/v1`), 12h cache, one fetch serves all
  scorings.
- `SleeperLeague.getDraftBoard` fetches ADP + projections in parallel and sets
  `BoardEntry.projectedPoints`; `assembleBoard` already passes
  `leagueSettings`, so `buildBoard` computes VOR unchanged.
- `tests/sleeper-projections.spec.ts` (3). Typecheck clean, 180 unit tests
  pass.

Verified live: `PROVIDER=sleeper npm run cheatsheet` → "season projections
present — VOR enabled", Gibbs VOR 160.4 (#1) / Bijan 153.9 (#2), the VOR-vs-ADP
summary populates. The draft assistant's `wait N` (VONA) and point-based tier
cliffs now work on Sleeper — full parity with the ESPN board.

Phases 3 (roster/waivers) and 4 (writes) remain.

## Addendum — Phase 3 shipped (2026-09-08)

`getRoster` / `getFreeAgents` on Sleeper (needs `SLEEPER_LEAGUE_ID` — a mock
draft has no roster and throws with that message).

- `projections.ts` grew `fetchSleeperWeeklyProjections` (per-week, 3h) and
  `fetchSleeperSeasonStats` (`api.sleeper.com/stats`, actuals, 6h); shared
  `fetchRows` + the same `parseProjections` (identical row shape).
- `maps.ts` (pure) + tests: `startingSlotCodes(roster_positions)`,
  `eligibleSlotsFor(pos, sp)` (flex/superflex from `fantasy_positions`),
  `mapRoster(roster, positions, byId, {week,season,actual})` (`starters[]`
  positionally aligned to `roster_positions`; `reserve` → IR; rest → BN),
  `mapFreeAgent(sp, bundle, trendCount)` (`pctChange` = a log-scaled trending
  add count; `availability` always `"FA"`, `pctOwned` always 0 — Sleeper
  doesn't expose per-player waiver state / % rostered cheaply).
- `SleeperLeague`: `getRoster` finds my roster by `owner_id === userId`;
  `getFreeAgents` = dump − union of all rosters, projections-filtered, sorted by
  season proj, top 250. `currentWeek()` from `/state/nfl`; `statBundle()`
  fetches weekly + season proj + season stats in parallel.
- `show-roster.ts` / `waivers.ts` are already provider-agnostic — no CLI
  changes.

`tests/sleeper-maps.spec.ts` +4. Typecheck clean, 184 unit tests pass. Verified
live against a real Sleeper league: `npm run roster` renders the full table
with correct slots + weekly/season/actual points; `npm run waivers` produces
ranked add/drop pairs.

## Addendum — Phase 4 shipped (2026-09-08)

`applyLineup` on Sleeper — the lineup *write*.

- GraphQL introspection (`__schema.mutation_type`, snake-cased) named the
  mutation: **`roster_update_starters(league_id: Snowflake, roster_id: Int,
  starters: String)`** — `starters` is a JSON-encoded array of player ids
  positionally aligned with the league's starting slots.
- `SleeperConfig.token` ← `SLEEPER_TOKEN` (bearer from a logged-in session,
  writes only; reads never need it). `SleeperClient.graphql(query, vars)` posts
  to `api.sleeper.app/graphql` with `Authorization: Bearer`, unwraps
  `data`/`errors`, friendly 401/403.
- `maps.ts` `buildStarters(plan)` (pure) = `assignments.map(a => a.player?.id ??
  "0")`. `SleeperLeague.applyLineup` builds it, resolves `roster_id` (shared
  `myRoster()` with `getRoster`), and fires the mutation. `--dry-run` prints
  the payload and returns.
- `set-lineup.ts` is already provider-agnostic (`Submit these changes to
  Sleeper?`). Also: `process.exit(1)` → `process.exitCode` in the roster /
  waivers / lineup CLIs (the Windows/tsx mid-fetch libuv abort).
- `tests/sleeper-maps.spec.ts` +1. 185 unit tests pass.

**Not verified** — the real submit needs a `SLEEPER_TOKEN` and a live lineup
change. Same status as ESPN's `POST transactions/`: implemented, `--dry-run`
works end-to-end (verified live), the mutation itself is best-effort from
introspection. Eyeball a `--dry-run` and confirm the first real submit lands in
the Sleeper app.

## Open items / risks

- ~~**FantasyPros ADP page structure**~~ — resolved by recon (2026-09-08). The
  FP ADP page is a server-rendered HTML table with no embedded JSON;
  **FantasyFootballCalculator's `/api/v1/adp` JSON API** is used instead —
  simpler *and* carries `high`/`low`/`stdev`. Sleeper has no public ADP endpoint
  (all guesses 404). Fallback if FFC ever breaks: order by ECR (already
  fetched) and set `adp = ecrRank` as a proxy for the survival model.
- **Sleeper DEF ids** — team-code strings (`"KC"`), not numerics. The pick
  mapper and universe filter must special-case them; identity join to ADP/ECR
  is by team abbr.
- **`linear` drafts** — Sleeper supports non-snake linear drafts; `snake.ts`
  turn math is snake-only. Detect and either support linear (`mySlots` variant)
  or warn and fall back to no turn math.
- **Auction drafts** — out of scope, same as ESPN. `getDraftState` still works;
  the assistant's turn math doesn't apply.
- **Does the user have a Sleeper league?** Current leagues are Yahoo + ESPN.
  Phase 1 is testable today against a free Sleeper mock draft regardless; a real
  redraft league would need to be created/moved for next season.
- **IDP** — the ESPN league is IDP; a Sleeper league may or may not be. The
  slot-code map covers IDP positions; VOR stays offense-only (unchanged).
- **Projections gap** is the whole reason roster/waivers are phase 3 — Sleeper
  gives none, so every non-draft feature needs a scrape the ESPN provider got
  for free from `kona_player_info`.
