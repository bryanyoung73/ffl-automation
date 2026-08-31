# CLAUDE.md

Context for AI assistants working in this repo.

## What this is

TypeScript automation for a fantasy football team. Two features:
1. **Draft cheat sheet** (`npm run cheatsheet`) — shipped, verified live (Yahoo).
2. **Weekly lineup optimizer** (`npm run lineup`) — built; Yahoo selectors
   unverified.

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

## Current status (2026-08-29)

- **League is an Offline Draft.** Drafted off Yahoo, results keyed in after.
  Nothing consumes `editprerank`, so there's no "push my rankings to Yahoo" —
  the cheat sheet is a printable/CSV reference.
- **A valid login session exists** at `.auth/storageState.json` (Google via the
  CDP-Chrome flow). `npm run cheatsheet` works end to end against live Yahoo.
- **Draft cheat sheet — DONE.** `LeagueSettingsPage` + `DraftRankingsPage`
  verified against league 891808. `src/draft/board.ts` (pure) + `renderBoard()`
  in `report.ts`. 36 unit tests pass.
- **Lineup optimizer — selectors still unverified.** `src/pages/LineupPage.ts`
  `SELECTORS` are best guesses; tune against the real roster DOM after the draft.
  `applyPlan()` assumes the classic per-row `<select>` UI.
- **Deferred (v2 building blocks, tested but NOT wired):** `src/draft/vor.ts`,
  `src/draft/diff.ts`, the `buildCheatSheet`/`renderReport` override path in
  `report.ts`, `src/draft/signals/`. These need Yahoo projected points, which
  only load on per-row expand on `editprerank` (300 clicks) — a separate
  projections scrape is the v2 task.

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
    LineupPage.ts           lineup selectors; roster scrape + submit (UNVERIFIED)
    LeagueSettingsPage.ts   settings + team count (verified)
    DraftRankingsPage.ts    editprerank scrape: rank/adp/xrank/bye/pos (verified)
  lineup/
    optimizer.ts       PURE branch-and-bound lineup optimizer, unit-tested
    types.ts
  draft/
    board.ts           PURE cheat-sheet builder (ADP order, tiers, flags) — SHIPPED
    report.ts          renderBoard() [shipped] + override renderers [v2, unused]
    types.ts
    vor.ts  diff.ts     PURE, unit-tested, v2 — NOT wired
    signals/            SignalProvider interface + FantasyPros stub — v2
  cli/                 provider-agnostic: loadConfig() -> getProvider(config)
    launch-chrome.ts   `npm run login:chrome` (Yahoo)
    login.ts           `npm run login` (Yahoo; CDP attach or fallback)
    show-roster.ts     `npm run roster` (read-only)
    set-lineup.ts      `npm run lineup`
    cheatsheet.ts      `npm run cheatsheet` (--threshold / --pos) — SHIPPED
    prompt.ts
tests/
  optimizer.spec.ts  vor.spec.ts  diff.spec.ts  report.spec.ts  board.spec.ts
  espn-maps.spec.ts  espn-league.spec.ts   pure logic, no browser
  fixtures/espn-league.sample.json          hand-built; swap for a real dump
  lineup-page.spec.ts  draft-rankings-page.spec.ts
                       live Yahoo checks, auto-skip without a session
```

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

## Next task (post-draft, lineup optimizer)

User runs `npm run roster` and shares the output / an `output/` dump. Then:
verify/fix `LineupPage` `SELECTORS`, confirm
`readRoster()` returns real players with projections and correct slot codes, then
validate `set-lineup --dry-run` before a live submit.
