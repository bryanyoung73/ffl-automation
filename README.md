# ffl-automation

Fantasy football automation with three back ends, chosen by `PROVIDER` in `.env`:

- **`PROVIDER=yahoo`** (default) — drives a real browser (Playwright) against
  Yahoo. Needs a one-time manual login (below).
- **`PROVIDER=espn`** — ESPN's Fantasy v3 JSON API over `fetch`. No browser;
  private leagues just need two cookies in `.env`.
- **`PROVIDER=sleeper`** — Sleeper's public read API. **No auth at all.** Draft
  features only for now (`npm run draft`); roster/waivers land later. It's the
  only back end whose API carries live draft picks.

Commands:

- **`npm run cheatsheet`** — printable draft board ordered by ADP with tiers,
  flagging where the source's expert rank disagrees with the draft room, with a
  Chatter column from news/injury intel (`--blend` to reorder by it).
- **`npm run roster`** — current roster with projections and injury status
  (nudged weekly by injury/news chatter and Vegas implied totals).
- **`npm run lineup`** — optimize the weekly starting lineup from projections,
  show a diff, confirm, submit (`--dry-run` to just print).
- **`npm run draft`** — (ESPN) live draft assistant: polls the draft and prints
  ranked, need-adjusted pick recommendations with reasons as picks come off.

Same code path for both providers — only the data source changes.

## How authentication works

### ESPN (`PROVIDER=espn`)

No browser. For a **private** league, copy two cookies from a browser that's
logged in to <https://fantasy.espn.com> (DevTools → Application → Cookies) into
`.env`:

```
ESPN_S2=<long url-encoded value>
ESPN_SWID={XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
```

Also set `ESPN_LEAGUE_ID`, `ESPN_TEAM_ID`, `ESPN_SEASON`. A `401/403` from ESPN
means those cookies are stale — grab fresh ones. Public leagues need no cookies.

### Yahoo (`PROVIDER=yahoo`)

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
npx playwright install chromium   # Yahoo only
cp env.example .env                # created automatically on first run too; edit if needed
```

Then set `PROVIDER` in `.env`. For ESPN, fill the `ESPN_*` block and you're done
— skip the Chrome login below.

### Logging in (Yahoo, Google sign-in)

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
| `npm run cheatsheet` | Draft board: players by ADP, snake-round tiers, flags where the **FantasyPros consensus (ECR)** disagrees with ADP, a **VOR** column (value over replacement, from season projections), plus a Chatter column from news/injury intel. Writes `output/cheatsheet-<date>.{md,csv}`. Read-only. |
| `npm run cheatsheet -- --no-ecr` | Skip the ECR fetch; flag against the source's own rank instead. |
| `npm run cheatsheet -- --threshold 25` | Stricter flag bar (default 18). |
| `npm run cheatsheet -- --pos QB` | One position only. |
| `npm run cheatsheet -- --blend` | Reorder the board by ADP shifted by chatter impact (shows a Δ column). |
| `npm run cheatsheet -- --no-intel` | Skip the chatter pass. `--refresh` re-fetches it. |
| `npm run cheatsheet -- --llm` | Use the Claude news digest instead of keyword scoring (needs `ANTHROPIC_API_KEY`). Works on `roster` / `lineup` / `intel` too. |
| `npm run draft` | (ESPN) Live draft assistant. Assembles the board once, then polls `mDraftDetail` and re-renders a ranked, need-adjusted pick list with reasons (turn math, "will he last?", tier cliffs, positional runs). Snake only. `--slot <n>` (else auto-detected from your round-1 pick), `--interval <s>` (default 5), `--top <n>` (default 6), `--once` (print once and exit), `--no-ecr` / `--no-intel` / `--llm` / `--refresh`. Records a JSONL draft log to `output/` by default (`--no-record` to skip). Read-only. |
| `npm run draft:review -- <logfile>` | Read a recorded draft log and print a calibration report: observed survival `sigma(adp)` vs the model, bucket reliability + Brier, VOR tier-gap distribution, and recommendation hit rate — with suggested constant values. `--csv` also dumps the raw `(adp, adp_error)` points. Pure, no network. |
| `npm run intel` | Preview the chatter/news intel for the current roster (`--refresh`, `--season`, `--llm`). |
| `npm run waivers` | (ESPN) Add/drop recommendations: ranks free agents + your bench by a blended value, pairs each worthwhile add with its best legal drop, lists DEF/K streams. `--win-now`, `--pos`, `--limit`, `--csv`, `--llm`. Read-only. |
| `npm run roster` | Current roster: slot, player, projection (chatter-adjusted), injury status. Read-only. |
| `npm run lineup` | Optimize the lineup (on chatter-adjusted projections), show a diff, confirm, submit. |
| `npm run lineup -- --dry-run` | Optimize and print only. Never submits. |
| `npm run lineup -- --yes` | Skip the confirmation prompt. |
| `npm run lineup -- --pin 12345` | Force player id `12345` to keep its current start slot (repeatable). |
| `npm run lineup -- --no-intel` | Optimize on raw projections, no chatter adjustment. |
| `npm test` | Unit tests + live page-object check (the live check auto-skips with no session). |
| `npm run test:unit` | Optimizer unit tests only — fast, no browser. |
| `npm run codegen` | Open Playwright codegen against Yahoo to grab real selectors. |
| `npm run typecheck` | `tsc --noEmit`. |

## Configuration (`.env`)

| Var | Default | Notes |
| --- | --- | --- |
| `PROVIDER` | `yahoo` | `yahoo`, `espn` or `sleeper` — data source for every command. |
| `YAHOO_LEAGUE_ID` | `891808` | From your team URL. Required when `PROVIDER=yahoo`. |
| `YAHOO_TEAM_ID` | `14` | The `mid=` in your team URL. |
| `YAHOO_BASE_URL` | `https://football.fantasysports.yahoo.com` | |
| `HEADLESS` | `true` | `false` to watch `roster`/`lineup` run. `login` is always headed. |
| `STORAGE_STATE_PATH` | `.auth/storageState.json` | Saved Yahoo session location. |
| `YAHOO_WEEK` | _(current)_ | Pin a week 1–18; blank = provider's current week. |
| `ESPN_LEAGUE_ID` | `1144783883` | `leagueId=` in your ESPN team URL. Required when `PROVIDER=espn`. |
| `ESPN_TEAM_ID` | `5` | `teamId=` in your ESPN team URL. |
| `ESPN_SEASON` | _(current year)_ | e.g. `2026`. |
| `ESPN_S2` / `ESPN_SWID` | — | Cookies for a private league (see above). |
| `ESPN_WEEK` | _(current)_ | Pin a week; falls back to `YAHOO_WEEK` then ESPN's current period. |
| `SLEEPER_LEAGUE_ID` | — | From `sleeper.com/leagues/<id>`. Required when `PROVIDER=sleeper`. |
| `SLEEPER_USERNAME` | — | Your Sleeper handle (resolved to a user id). Or set `SLEEPER_USER_ID`. |
| `SLEEPER_SEASON` | _(current year)_ | e.g. `2026`. |
| `INTEL_LLM` | _(off)_ | `1` to default the Claude news digest on (same as passing `--llm`). |
| `INTEL_LLM_MODEL` | `claude-opus-5` | Model for the digest. `claude-haiku-4-5` is ~15x cheaper. |
| `ANTHROPIC_API_KEY` | — | Required only when the LLM digest is used. Sleeper + ESPN news need no key. |

## Layout

```
src/
  config.ts            .env loading; PROVIDER switch + per-provider vars
  providers/
    types.ts               LeagueProvider interface
    index.ts               getProvider(config)
    yahoo/YahooLeague.ts    wraps the Playwright page objects
    espn/                   client.ts + maps.ts (pure) + EspnLeague.ts
  browser.ts           browser context from the saved session (Yahoo)
  pages/
    TeamPage.ts             login checks, output/ debug dumps
    LineupPage.ts           classic team editor: roster scrape + lineup submit
    LeagueSettingsPage.ts   league settings + team count
    DraftRankingsPage.ts    editprerank scrape (pre-draft only)
  lineup/optimizer.ts  pure: roster + projections -> optimal legal lineup
  draft/board.ts       pure: pre-rank data -> ADP-ordered tiered cheat sheet
  draft/report.ts      pure: renderBoard() markdown + csv
  cli/                 provider-agnostic entry points (loadConfig -> getProvider)
tests/                 *.spec.ts — pure logic (no browser, incl. espn-*) + live
                       Yahoo checks that auto-skip without a session
  fixtures/            sample ESPN payload
```

## Adjusting selectors

Yahoo ships no stable test IDs and its class names rotate, so the page objects
anchor on structural hooks (`select[name]`, `data-pos`, ARIA attributes, column
order). If a scrape breaks after a Yahoo redesign, `readRoster()` /
`readPreRank()` dump the page HTML + a screenshot to `output/`; `npm run codegen`
opens Playwright's inspector against Yahoo to find new anchors.

Eligible slots and the current slot come straight from each player's
`<select>` options, so flex rules (`W/R/T`, `W/R`, `Q/W/R/T`, …) are picked up
automatically — no config needed.
