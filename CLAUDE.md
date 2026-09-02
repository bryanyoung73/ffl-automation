# CLAUDE.md

Context for AI assistants working in this repo.

## What this is

TypeScript automation for a fantasy football team, against Yahoo or ESPN
(see Providers). Two features:
1. **Draft cheat sheet** (`npm run cheatsheet`) — shipped, verified live on
   both providers (pre-draft only).
2. **Weekly lineup optimizer** (`npm run roster` / `npm run lineup`) — verified
   live read-side on Yahoo; the real submit and the ESPN roster path are not
   yet exercised (see Current status).

Stack: `@playwright/test`, `tsx` for CLIs, ESM, strict TS. No framework.

## Providers

`PROVIDER` in `.env` (`yahoo` default | `espn`) picks the data source for every
command. Both implement `LeagueProvider` (`src/providers/types.ts`) and return
the same provider-agnostic shapes, so `draft/` and `lineup/` never branch on it.

- **yahoo** (`src/providers/yahoo/YahooLeague.ts`) — the original path: wraps
  `browser.ts` + `pages/*`, no behaviour change. Needs the Chrome login (below).
- **espn** (`src/providers/espn/`) — ESPN's unofficial Fantasy v3 JSON API over
  `fetch`. No browser. Private leagues need `ESPN_S2` + `ESPN_SWID` cookies in
  `.env` (copy from a logged-in browser). Id/scoring/projection mapping is in
  pure, unit-tested `maps.ts` + the exported mappers in `EspnLeague.ts`; the
  write path (`applyLineup` → `POST transactions/`) is unofficial, so
  `--dry-run` first. See `docs/specs/2026-08-31-espn-api-provider.md`.

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
    types.ts
    vor.ts  diff.ts     PURE, unit-tested, v2 — NOT wired
    signals/            SignalProvider interface + FantasyPros stub — v2
  intel/               chatter/news signal for draft + weekly (spec 2026-09-02)
    types.ts  cache.ts  match.ts (Sleeper identity)  apply.ts (PURE merge +
    adjust)  collect.ts (orchestrator + disk cache)  weekly.ts (roster/lineup
    entry)  providers/{sleeper,espnNews}.ts
  cli/                 provider-agnostic: loadConfig() -> getProvider(config)
    launch-chrome.ts   `npm run login:chrome` (Yahoo)
    login.ts           `npm run login` (Yahoo; CDP attach or fallback)
    show-roster.ts     `npm run roster` (read-only; intel-adjusted)
    set-lineup.ts      `npm run lineup` (intel-adjusted projections)
    cheatsheet.ts      `npm run cheatsheet` (--threshold/--pos/--blend/--no-intel) — SHIPPED
    intel.ts           `npm run intel` — preview the roster's chatter
    prompt.ts
tests/
  optimizer.spec.ts  vor.spec.ts  diff.spec.ts  report.spec.ts  board.spec.ts
  espn-maps.spec.ts  espn-league.spec.ts  board-intel.spec.ts
  intel-match.spec.ts  intel-apply.spec.ts  intel-espn-news.spec.ts
                       pure logic, no browser
  fixtures/espn-league.sample.json          hand-built; swap for a real dump
  lineup-page.spec.ts  draft-rankings-page.spec.ts
                       live Yahoo checks, auto-skip without a session
```

## Player intel

`src/intel/` gathers chatter/news per player and feeds both pipelines:
- **weekly** (`roster`, `lineup`): `applyWeeklyIntel` nudges `projectedPoints`
  by `weekImpact` before the optimizer runs; deltas + notes are printed.
- **draft** (`cheatsheet`): `buildBoard({ intel, blend })` — annotates a Chatter
  column by default; `--blend` reorders by ADP shifted by `seasonImpact`.

Sources: Sleeper (`injury_status` / practice / trending — the workhorse) and
ESPN player news (name-led actionable blurbs only; roundup/opinion articles are
dropped). Bundles cache to `.cache/` (gitignored). `match.ts` joins players
across providers via the Sleeper dump (`espn_id` + `yahoo_id`). Keyword scoring
is deliberately timid — real news extraction is Phase 3 (LLM). `--no-intel`
bypasses; `--refresh` re-fetches. See `docs/specs/2026-09-02-player-intel.md`.

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
  them (`defaultPositionId` scheme is the usual first fix).
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
