# CLAUDE.md

Context for AI assistants working in this repo.

## What this is

Playwright + TypeScript automation for a Yahoo Fantasy Football team
(league `891808`, team `14`). Primary feature: auto-optimize the weekly starting
lineup from Yahoo's own projections, show a diff, confirm, submit.

Stack: `@playwright/test`, `tsx` for CLIs, ESM, strict TS. No framework.

## Current status (2026-08-28)

- Scaffolding complete, committed. `npm run typecheck` and `npm test` pass
  (11 optimizer unit tests; the live scrape test auto-skips without a session).
- **The fantasy draft has not happened yet.** There is no roster to read, so
  `npm run roster` / `npm run lineup` can't be meaningfully exercised.
- **Yahoo selectors in `src/pages/LineupPage.ts` (`SELECTORS` object) are
  unverified best guesses.** They MUST be tuned against the real logged-in DOM
  after the draft. `readRoster()` / `applyPlan()` dump page HTML + a screenshot
  to `artifacts/` on a selector miss — use those to fix selectors.
- `applyPlan()` (submitting lineup changes) assumes Yahoo's classic per-row
  `<select>` UI. If the league uses the drag/swap UI, that method needs a rewrite.

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
    TeamPage.ts        login-state checks, artifacts/ debug dumps
    LineupPage.ts      ALL Yahoo selectors; roster scraping + lineup submit
  lineup/
    optimizer.ts       PURE branch-and-bound optimizer, fully unit-tested
    types.ts
  cli/
    launch-chrome.ts   `npm run login:chrome`
    login.ts           `npm run login` (CDP attach or fallback)
    show-roster.ts     `npm run roster` (read-only)
    set-lineup.ts      `npm run lineup` (--dry-run / --yes / --pin <id>)
    prompt.ts
tests/
  optimizer.spec.ts    pure logic, no browser
  lineup-page.spec.ts  live scrape check, auto-skips without a session
```

## Conventions

- All Yahoo selectors go in `LineupPage.ts` `SELECTORS` only — nowhere else.
- `optimizer.ts` stays pure (no Playwright imports). Test it in isolation.
- Flex rule assumed `W/R/T` (RB/WR/TE). See `deriveEligibleSlots()` if the
  league differs.
- Never commit `.env`, `.auth/`, `artifacts/` (all gitignored).
- Commit only when the user asks.

## Next task (post-draft)

User runs `npm run login:chrome` + `npm run login` + `npm run roster` and shares
the output / an `artifacts/` dump. Then: verify/fix `SELECTORS`, confirm
`readRoster()` returns real players with projections and correct slot codes, then
validate `set-lineup --dry-run` before a live submit.
