# ffl-automation

Playwright automation for a Yahoo Fantasy Football team. Auto-optimizes the
weekly starting lineup from Yahoo's own projections.

Team: league `891808`, team `14`
(<https://football.fantasysports.yahoo.com/f1/891808?mid=14>)

## How authentication works

There are **no credentials in this project.** You log in by hand once in a real
browser; Playwright saves the resulting session (cookies + local storage) to
`.auth/storageState.json` (gitignored). Every other command reuses that file and
is already signed in.

Yahoo sessions last a few weeks. When a command says the session expired, run
`npm run login` again.

> Automating the Google login itself is deliberately avoided — Google blocks it
> with bot checks and 2FA. If you ever need fully unattended operation, switch to
> the official [Yahoo Fantasy Sports API](https://developer.yahoo.com/fantasysports/guide/)
> with OAuth instead of browser automation.

## Setup

```bash
npm install
npx playwright install chromium
cp env.example .env      # created automatically on first run too; edit if needed
```

### Logging in (Google sign-in)

Google blocks OAuth in browsers that Playwright launches ("this browser may not
be secure"). So the login step drives your **real installed Chrome** instead:

```bash
npm run login:chrome     # opens your Chrome with a debug port + dedicated profile
#   -> in that window, sign in to Yahoo with Google, land on your team page, leave it open
npm run login            # in a second terminal: attaches, saves .auth/storageState.json
```

`login:chrome` uses a separate profile in `.auth/chrome-profile/` (gitignored),
so it never touches your everyday Chrome and you don't have to close it. You only
repeat this when Yahoo expires the session (every few weeks).

If you instead add a **password** to your Yahoo account (Yahoo Account → Security),
plain `npm run login` can automate the Yahoo email+password form directly with no
Chrome dance.

## Commands

| Command | What it does |
| --- | --- |
| `npm run login:chrome` | Launch your real Chrome (debug port + dedicated profile) to sign in. |
| `npm run login` | Attach to that Chrome (or fall back to a bundled browser) and save the session. |
| `npm run roster` | Print current roster: slot, player, projection, injury status. Read-only. |
| `npm run lineup` | Optimize the lineup, show a diff, confirm, submit. |
| `npm run lineup -- --dry-run` | Optimize and print only. Never submits. |
| `npm run lineup -- --yes` | Skip the confirmation prompt. |
| `npm run lineup -- --pin 12345` | Force player id `12345` to keep its current start slot (repeatable). |
| `npm test` | Unit tests + live page-object check (the live check auto-skips with no session). |
| `npm run test:unit` | Optimizer unit tests only — fast, no browser. |
| `npm run codegen` | Open Playwright codegen against Yahoo to grab real selectors. |
| `npm run typecheck` | `tsc --noEmit`. |

## Configuration (`.env`)

| Var | Default | Notes |
| --- | --- | --- |
| `YAHOO_LEAGUE_ID` | `891808` | From your team URL. |
| `YAHOO_TEAM_ID` | `14` | The `mid=` in your team URL. |
| `YAHOO_BASE_URL` | `https://football.fantasysports.yahoo.com` | |
| `HEADLESS` | `true` | `false` to watch `roster`/`lineup` run. `login` is always headed. |
| `STORAGE_STATE_PATH` | `.auth/storageState.json` | Saved session location. |
| `YAHOO_WEEK` | _(current)_ | Pin a week 1–18; blank = Yahoo's current week. |

## Layout

```
src/
  config.ts            .env loading + derived URLs
  browser.ts           browser context from the saved session
  pages/
    TeamPage.ts        login checks, debug dumps
    LineupPage.ts      ALL Yahoo selectors; roster scraping + lineup submit
  lineup/
    optimizer.ts       pure: roster + projections -> optimal legal lineup
    types.ts
  cli/
    launch-chrome.ts  login.ts  show-roster.ts  set-lineup.ts  prompt.ts
tests/
  optimizer.spec.ts    pure logic, no browser
  lineup-page.spec.ts  live scrape check (auto-skips without a session)
```

## Adjusting selectors

Yahoo ships no stable test IDs, so `src/pages/LineupPage.ts` starts with
**best-guess selectors**. After your first `npm run login`:

```bash
npm run roster     # see what the current selectors scrape
npm run codegen    # click your real lineup page, copy better selectors
```

Every selector is in the `SELECTORS` object at the top of `LineupPage.ts` with
primary + fallback guesses. `readRoster()` and `applyPlan()` save page HTML and a
screenshot to `artifacts/` when they can't find what they expect.

The flex rule is assumed to be `W/R/T` (RB/WR/TE eligible). If your league differs,
edit `deriveEligibleSlots()` in `LineupPage.ts`.
