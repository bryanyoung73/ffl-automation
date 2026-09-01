# CLAUDE.md

Context for AI assistants working in this repo.

## What this is

Playwright + TypeScript automation for a Yahoo Fantasy Football team
(league `891808`, team `14`). Two features:
1. **Draft cheat sheet** (`npm run cheatsheet`) — shipped, verified live.
2. **Weekly lineup optimizer** (`npm run lineup`) — built, selectors unverified,
   blocked until there's a post-draft roster.

Stack: `@playwright/test`, `tsx` for CLIs, ESM, strict TS. No framework.

## Current status (2026-09-01)

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
- **Deferred (v2, tested, NOT wired):** `src/draft/vor.ts`, `src/draft/diff.ts`,
  the override renderers in `report.ts`, `src/draft/signals/`.

## Auth model

No credentials in the repo. Google blocks OAuth in Playwright-launched browsers,
so login drives the user's real installed Chrome:

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
  config.ts            .env loading (auto-creates from env.example) + derived URLs
  browser.ts           browser context from saved storageState
  pages/
    TeamPage.ts             login-state checks, output/ debug dumps
    LineupPage.ts           classic team editor: roster scrape (verified) + submit
    LeagueSettingsPage.ts   settings + team count (verified)
    DraftRankingsPage.ts    editprerank scrape (verified pre-draft; 404s post-draft)
  lineup/
    optimizer.ts       PURE branch-and-bound lineup optimizer, unit-tested
    types.ts
  draft/
    board.ts           PURE cheat-sheet builder (ADP order, tiers, flags) — SHIPPED
    report.ts          renderBoard() [shipped] + override renderers [v2, unused]
    types.ts
    vor.ts  diff.ts     PURE, unit-tested, v2 — NOT wired
    signals/            SignalProvider interface + FantasyPros stub — v2
  cli/
    launch-chrome.ts   `npm run login:chrome`
    login.ts           `npm run login` (CDP attach or fallback)
    show-roster.ts     `npm run roster` (read-only, unverified)
    set-lineup.ts      `npm run lineup` (unverified)
    cheatsheet.ts      `npm run cheatsheet` (--threshold / --pos) — SHIPPED
    prompt.ts
tests/
  optimizer.spec.ts  vor.spec.ts  diff.spec.ts  report.spec.ts  board.spec.ts
                       pure logic, no browser (36 tests)
  lineup-page.spec.ts  draft-rankings-page.spec.ts
                       live checks, auto-skip without a session
```

## Conventions

- Yahoo selectors live only in the relevant page object. Class names on Yahoo's
  React pages are hashed (`_ys_xxx`) and rotate — anchor on ARIA / roles / text,
  never on those classes. `DraftRankingsPage` anchors on
  `[aria-controls^="player-projections-"]`.
- Functions passed to `page.evaluate` must be top-level declarations with NO
  nested named functions — `tsx`/esbuild injects `__name()` helpers that don't
  exist in the browser context (`ReferenceError: __name is not defined`).
- `optimizer.ts`, `board.ts`, `vor.ts`, `diff.ts` stay pure (no Playwright
  imports). Test in isolation.
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
