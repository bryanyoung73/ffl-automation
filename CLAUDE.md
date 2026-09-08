# CLAUDE.md

Context for AI assistants working in this repo.

## What this is

TypeScript automation for a fantasy football team, against Yahoo or ESPN
(see Providers). Features:
1. **Draft cheat sheet** (`npm run cheatsheet`) — ADP board + ECR/VOR/chatter.
   Shipped, verified live (pre-draft only).
2. **Weekly lineup optimizer** (`npm run roster` / `npm run lineup`) — verified
   live read-side on Yahoo; the real submit and the ESPN roster path are not
   yet exercised (see Current status).
3. **Waiver wire** (`npm run waivers`, ESPN + Sleeper) — ranks free agents +
   your bench by a blended value (ROS + this week + buzz), pairs adds with legal
   drops, lists DEF/K streams. Phase 1; see
   `docs/specs/2026-09-03-waiver-wire.md`.
4. **Player intel** (`src/intel/`) — chatter/news/injury/Vegas signal feeding
   1–3.
5. **Live draft assistant** (`npm run draft`, ESPN only) — polls `mDraftDetail`,
   subtracts drafted players from the board, and prints ranked need-adjusted
   pick recommendations with reasons (turn math, survival odds, tier cliffs,
   positional runs). Snake only. See
   `docs/specs/2026-09-03-live-draft-assistant.md`.

Stack: `@playwright/test`, `tsx` for CLIs, ESM, strict TS. No framework.

## Providers

`PROVIDER` in `.env` (`yahoo` default | `espn` | `sleeper`) picks the data
source for every command. All implement `LeagueProvider`
(`src/providers/types.ts`) and return the same provider-agnostic shapes, so
`draft/` and `lineup/` never branch on it.

- **yahoo** (`src/providers/yahoo/YahooLeague.ts`) — the original path: wraps
  `browser.ts` + `pages/*`, no behaviour change. Needs the Chrome login (below).
- **espn** (`src/providers/espn/`) — ESPN's unofficial Fantasy v3 JSON API over
  `fetch`. No browser. Private leagues need `ESPN_S2` + `ESPN_SWID` cookies in
  `.env` (copy from a logged-in browser). Id/scoring/projection mapping is in
  pure, unit-tested `maps.ts` + the exported mappers in `EspnLeague.ts`; the
  write path (`applyLineup` → `POST transactions/`) is unofficial, so
  `--dry-run` first. See `docs/specs/2026-08-31-espn-api-provider.md`.
  Note (2026-09-07): `mDraftDetail` does **not** carry live picks during a
  clock-running draft — it stays a skeleton until the draft completes. So the
  live draft assistant only works on ESPN *after the fact*. Sleeper is the fix.
- **sleeper** (`src/providers/sleeper/`) — Sleeper's public read API, **no auth**
  (no token, no cookies). Phase 1 = draft only: `getLeagueSettings`,
  `getDraftState` (live picks + my slot, which Sleeper assigns up front), and an
  ADP-ordered `getDraftBoard` (player pool from the `/players/nfl` dump +
  `src/draft/adp.ts` FantasyFootballCalculator ADP, which also brings
  `high`/`low`/`stdev`, + Sleeper's own season projections
  (`sleeper/projections.ts`, `api.sleeper.com`) → VOR, parity with the ESPN
  board). `getRoster` / `getFreeAgents` also work (needs `SLEEPER_LEAGUE_ID`,
  not a mock): rosters from `/league/<id>/rosters` + weekly/season projections
  + season stats + trending-add buzz. `applyLineup` throws `NOT_SUPPORTED`
  (phase 4 — needs a token). Pure mappers in `maps.ts`. Config:
  `SLEEPER_LEAGUE_ID` **or** `SLEEPER_DRAFT_ID` (a mock draft has no league —
  settings then come from the draft's own `slots_*`), plus `SLEEPER_USERNAME`
  (all public). See `docs/specs/2026-09-08-sleeper-provider.md`.

## Current status (2026-09-02)

### Yahoo (league 891808)

- **Draft is complete.** League is an Offline Draft (was drafted off Yahoo).
- **Lineup optimizer — WORKING, verified live.** `npm run roster` and
  `npm run lineup --dry-run` run clean against the real roster.
  `src/pages/LineupPage.ts` rewritten for Yahoo's classic team editor: anchors on
  `select[name="<playerId>"]` (option values = eligible slots + BN; selected =
  current slot). `config.lineupUrl` pins `?stat1=P&stat2=PW` for weekly
  projections. `applyPlan()` (real submit) is written but **not yet run against
  live Yahoo** — needs a real lineup change to verify the Save step.
- **Draft cheat sheet — spent.** `editprerank` returns "There was a problem"
  post-draft; `DraftRankingsPage.readPreRank()` throws `PRERANK_UNAVAILABLE` with
  a friendly message and the live test skips. The `board.ts` / `renderBoard`
  code stays for next season's draft.
- **A valid login session exists** at `.auth/storageState.json` (Google via the
  CDP-Chrome flow).

### ESPN (league 1144783883, IDP)

- **Cheat sheet — verified live.** `PROVIDER=espn npm run cheatsheet` pulls 300
  ADP-ranked players and writes `output/cheatsheet-<date>.{md,csv}`.
- **Roster / lineup — wired, not yet verified.** League had not drafted as of
  2026-09-01, so rosters came back empty. Re-check `npm run roster` /
  `npm run lineup -- --dry-run` now that it may have drafted; IDP slots
  (LB/DL/DB) are recognised but IDP optimizer behaviour is untested.
- `byeWeek` is absent from ESPN pre-season → cheat-sheet Bye column shows "—".

- **Deferred (v2, tested, NOT wired):** `src/draft/vor.ts`, `src/draft/diff.ts`,
  the override renderers in `report.ts`, `src/draft/signals/`.

## Auth model

**ESPN** (`PROVIDER=espn`): no browser. Put `ESPN_S2` + `ESPN_SWID` (from a
browser logged in to fantasy.espn.com) in `.env`. `EspnClient` sends them as a
Cookie header; a 401/403 prints a "check ESPN_S2 / ESPN_SWID" message.

**Yahoo** (`PROVIDER=yahoo`): no credentials in the repo. Google blocks OAuth in
Playwright-launched browsers, so login drives the user's real installed Chrome:

1. `npm run login:chrome` — spawns real Chrome with `--remote-debugging-port`
   and a dedicated profile at `.auth/chrome-profile/` (gitignored). User signs
   in to Yahoo via Google by hand, lands on the team page, leaves it open.
2. `npm run login` — attaches over CDP (`http://localhost:9222`), waits for the
   team page, writes `.auth/storageState.json`. Falls back to a bundled browser
   if no CDP Chrome is found (only useful for a Yahoo password login).

Yahoo session cookies expire in ~weeks. Re-auth signal: commands print
"session expired / redirected to Yahoo login". Fix = repeat the two steps above
(the persistent Chrome profile usually means no Google re-challenge).

Adding a password to the Yahoo account would let plain `npm run login` automate
the Yahoo form directly and skip the Chrome dance — not done yet.

## Layout

```
src/
  config.ts            .env loading (auto-creates from env.example); PROVIDER
                       switch, Yahoo vars + derived URLs, ESPN_* -> EspnConfig
  providers/
    types.ts               LeagueProvider interface
    index.ts               getProvider(config) / providerLabel(config)
    yahoo/YahooLeague.ts    wraps browser.ts + pages/* (no behaviour change)
    espn/client.ts          fetch wrapper: cookies, x-fantasy-filter, errors
    espn/maps.ts            PURE: id<->code maps, scoring + projection helpers
    espn/EspnLeague.ts      provider impl + exported pure mappers
    sleeper/client.ts       fetch wrapper: no auth, GET memo, noCache
    sleeper/maps.ts         PURE: slot map, scoring, settings/draft/pick mappers
    sleeper/projections.ts  PURE parse + fetch: api.sleeper.com season/weekly proj + stats
    sleeper/SleeperLeague.ts provider impl: draft + roster + free agents (no writes)
  browser.ts           browser context from saved storageState (Yahoo only)
  pages/
    TeamPage.ts             login-state checks, output/ debug dumps
    LineupPage.ts           classic team editor: roster scrape (verified) + submit
    LeagueSettingsPage.ts   settings + team count (verified)
    DraftRankingsPage.ts    editprerank scrape (verified pre-draft; 404s post-draft)
  lineup/
    optimizer.ts       PURE branch-and-bound lineup optimizer, unit-tested
    types.ts
  draft/
    board.ts           PURE cheat-sheet builder (ADP order, tiers, flags,
                       optional chatter blend) — SHIPPED
    report.ts          renderBoard() [shipped] + override renderers [v2, unused]
    assemble.ts        assembleBoard() — shared getDraftBoard->ECR->intel->buildBoard
                       pipeline (cheatsheet + draft)
    ecr.ts             PURE FantasyPros ECR scrape + attach (rank + ceiling/floor)
    adp.ts             PURE FantasyFootballCalculator ADP (adp + high/low/stdev)
    types.ts
    vor.ts  diff.ts     PURE, unit-tested, v2 — NOT wired
    signals/            SignalProvider interface + FantasyPros stub — v2
    live/              PURE live-draft engine: snake.ts (turn math) needs.ts
                       (roster -> PositionNeed) survival.ts (willLast) context.ts
                       (tierCliffs/positionRuns) assistant.ts (computeAdvice ->
                       DraftAdvice) record.ts (draft-log builders) calibrate.ts
                       (calibrateFromLog -> constant suggestions) types.ts
  intel/               chatter/news signal for draft + weekly (spec 2026-09-02)
    types.ts  cache.ts  match.ts (Sleeper identity)  apply.ts (PURE merge +
    adjust)  collect.ts (orchestrator + disk cache)  weekly.ts (roster/lineup
    entry)  providers/{sleeper, espnNewsFeed (shared fetch), espnNews (keyword),
    newsDigest (LLM, --llm), vegas (implied totals + weather, week-only)}.ts
  cli/                 provider-agnostic: loadConfig() -> getProvider(config)
    launch-chrome.ts   `npm run login:chrome` (Yahoo)
    login.ts           `npm run login` (Yahoo; CDP attach or fallback)
    show-roster.ts     `npm run roster` (read-only; intel-adjusted)
    set-lineup.ts      `npm run lineup` (intel-adjusted projections)
    cheatsheet.ts      `npm run cheatsheet` (--threshold/--pos/--blend/--no-intel/--llm) — SHIPPED
    draft.ts           `npm run draft` (ESPN) — live draft assistant (poll + render + --record)
    draft-review.ts    `npm run draft:review -- <log>` — post-draft calibration report
    intel.ts           `npm run intel` — preview the roster's chatter
    waivers.ts         `npm run waivers` (ESPN) — add/drop recommendations
    prompt.ts
  waivers/             types.ts + value.ts (PURE blend) + pairs.ts (PURE
                       add/drop pairing, protection rules, streaming)
tests/
  optimizer.spec.ts  vor.spec.ts  diff.spec.ts  report.spec.ts  board.spec.ts
  espn-maps.spec.ts  espn-league.spec.ts  board-intel.spec.ts
  intel-match.spec.ts  intel-apply.spec.ts  intel-espn-news.spec.ts
  intel-news-digest.spec.ts  intel-vegas.spec.ts  intel-sleeper-role.spec.ts
  ecr.spec.ts  board-vor.spec.ts  waiver-value.spec.ts  waiver-pairs.spec.ts
  espn-draft-state.spec.ts  sleeper-maps.spec.ts  adp.spec.ts
  draft-snake.spec.ts  draft-needs.spec.ts
  draft-survival.spec.ts  draft-context.spec.ts  draft-assistant.spec.ts
  draft-record.spec.ts  draft-calibrate.spec.ts  draft-vona.spec.ts
                       pure logic, no browser
  fixtures/espn-league.sample.json          hand-built; swap for a real dump
  fixtures/espn-draft-detail.sample.json    hand-built mid-draft mDraftDetail
  lineup-page.spec.ts  draft-rankings-page.spec.ts
                       live Yahoo checks, auto-skip without a session
```

## Player intel

`src/intel/` gathers chatter/news per player and feeds both pipelines:
- **weekly** (`roster`, `lineup`): `applyWeeklyIntel` nudges `projectedPoints`
  by `weekImpact` before the optimizer runs; deltas + notes are printed.
- **draft** (`cheatsheet`): `buildBoard({ intel, blend })` — annotates a Chatter
  column by default; `--blend` reorders by ADP shifted by `seasonImpact`.

Sources: Sleeper (`injury_status` / practice / trending, plus depth-chart order
and age-curve risk — the workhorse), ESPN player news (name-led actionable
blurbs only; roundup/opinion articles are dropped), and — weekly only — Vegas
via the ESPN scoreboard (implied team total from the O/U + spread, plus light
game-script and weather nuance by position; `vegas.ts` is pure + unit-tested,
not run for the draft board). Bundles cache to `.cache/` (gitignored).
`match.ts` joins players across providers via the Sleeper dump (`espn_id` +
`yahoo_id`).

The draft board also carries `BoardEntry.adpChange` (ESPN
`averageDraftPositionPercentChange`) → an `↑`/`↓` next to the ADP number for
fast movers. Display-only; does not affect ordering or `--blend`.

**Expert baseline = FantasyPros ECR** (`src/draft/ecr.ts`, `--no-ecr` to skip).
`fetchEcr` scrapes `var ecrData` off the public cheat-sheet page (scoring-
matched: ppr / half-point / standard), `attachEcr` joins to board entries by
normalized name. When matched, `buildBoard` flags **ECR vs ADP** instead of the
source's single rank — a real many-ranker consensus, so the divergence flags
are trustworthy. Falls back to the source rank when the scrape fails.
`parseEcrHtml` / `attachEcr` are pure + tested. Real strength-of-schedule was
looked at and skipped — the positional-defense input isn't cleanly free.

**VOR column** — `src/draft/vor.ts` (pure, long-standing) is now wired. ESPN's
`kona_player_info` returns season projections (`seasonProjectedPoints` with a
`seasonId` guard), so `BoardEntry.projectedPoints` populates and `buildBoard`
(given `leagueSettings`) computes value-over-replacement per player. The `VOR`
column shows the value; a `↑N`/`↓N` when VOR rank disagrees with the player's
rank *among offense* by a round+, within the draftable range only. Offense
only — `computeVor` has no IDP model, so LB/DL/DB get no VOR. K/DEF get a value
but no gap arrow (flat curves + always-late ADP = structural noise). Summary
lists the biggest early-round VOR-vs-board gaps.

News scoring has two modes: `espnNews` (keyword, default — deliberately timid)
and `newsDigest` (LLM, opt-in via `--llm` or `INTEL_LLM=1`, needs
`ANTHROPIC_API_KEY`; `INTEL_LLM_MODEL` defaults to `claude-opus-5`). The digest
sends the actionable blurbs to Claude and gets back one structured
week/season/confidence + a summary note; per-player results cache under
`.cache/llm-digest/` keyed by a hash of the blurb text, so a `--refresh` that
doesn't change the news costs nothing. `--no-intel` bypasses all of it;
`--refresh` re-fetches. See `docs/specs/2026-09-02-player-intel.md`.

## Conventions

- Yahoo selectors live only in the relevant page object. Class names on Yahoo's
  React pages are hashed (`_ys_xxx`) and rotate — anchor on ARIA / roles / text,
  never on those classes. `DraftRankingsPage` anchors on
  `[aria-controls^="player-projections-"]`.
- Functions passed to `page.evaluate` must be top-level declarations with NO
  nested named functions — `tsx`/esbuild injects `__name()` helpers that don't
  exist in the browser context (`ReferenceError: __name is not defined`).
- `optimizer.ts`, `board.ts`, `vor.ts`, `diff.ts`, and `providers/espn/maps.ts`
  + the exported mappers in `EspnLeague.ts` stay pure (no Playwright / no
  `fetch`). Test in isolation against fixtures.
- ESPN id/slot/scoring maps in `maps.ts` are seeded from the community
  `espn-api` constants — calibrate against a real league dump before trusting
  them (`defaultPositionId` scheme is the usual first fix). Lineup slot 7
  (OP / superflex) maps to `"OP"`, *not* `"W/R/T"` — ESPN tags every QB as
  OP-eligible, so conflating them makes QBs look flex-eligible.
- Never commit `.env`, `.auth/`, `output/` (all gitignored). Generated cheat
  sheets land in `output/`.
- Commit only when the user asks.

## Next task

`applyPlan()` — the real lineup submit — has not run against live Yahoo yet.
Next time the optimizer actually wants a change (start-set differs, not just a
cosmetic slot swap), run `npm run lineup` for real and confirm the Save step
works: `SELECTORS.saveButton` tries `button.roster-save-btn` /
`button:has-text("Save Changes")` / `input[name="jsubmit"]`. The classic page's
save control was only seen as `<input type="hidden" name="jsubmit">` in the dump,
so the visible button selector may need adjusting.
