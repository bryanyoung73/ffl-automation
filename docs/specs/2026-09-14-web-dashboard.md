# Web dashboard: optimal lineup + waiver suggestions on your phone

Date: 2026-09-14
Status: Shipped (v1, read-only)

## Problem

Every feature in this repo is a terminal command. Checking the optimal lineup
or the waiver wire from a phone meant SSH-ing in and running `npm run
lineup`/`npm run waivers`. The ask: a small dashboard, installable as an app
icon (a PWA), reachable over the user's Tailscale tailnet — no public hosting,
no new auth layer (the tailnet already gates access) — showing exactly what
those two commands already compute. Read-only by design: no submit button.

## Scope

**In:** `npm run web` starts a local HTTP server serving a one-page dashboard
with two panels (lineup, waivers), each backed by a JSON API route that reuses
the CLIs' existing pipelines verbatim.

**Out:** submitting a lineup/waiver change from the page (a deliberate
follow-up, not v1 — it would need a write endpoint and a real confirm step,
same risk `applyLineup` already carries in the CLI); query-string overrides
(`--pos`/`--limit`/`--win-now`); public hosting/auth (tailnet-only).

## Reuse — this is entirely wiring, no new pure logic

| Need | Existing piece |
| --- | --- |
| Roster + starting slots | `provider.getRoster()` (`LeagueProvider`) |
| Intel-adjusted projections | `applyWeeklyIntel` (`src/intel/weekly.ts`) |
| Optimal lineup + diff | `optimizeLineup` / `diffLineup` (`src/lineup/optimizer.ts`) |
| Free agents + waiver ranking | `provider.getFreeAgents()`, `valuePlayers` (`src/waivers/value.ts`), `buildAddDrops` (`src/waivers/pairs.ts`) |
| Chatter/news for waivers | `collectIntel` (`src/intel/collect.ts`) |

`getProvider(config)` returns a fresh instance per call (no module-level
singletons — confirmed in `EspnClient`/`SleeperClient`/`YahooLeague`), so
calling it once per HTTP request is exactly as safe as every CLI already is.

## Approach

Kept to the repo's "no framework" convention: **zero new npm dependencies** —
`node:http` for the server, vanilla HTML/CSS/JS for the client (same spirit as
the ESPN/Sleeper providers, built on nothing but global `fetch`).

- **`src/server/data.ts`** — `getLineupView(config)` and `getWaiverView(config)`,
  thin async wrappers around the pipelines above. `getWaiverView` returns
  `{unavailable: true, reason}` for `PROVIDER=yahoo` (no free-agent read) or an
  empty roster, instead of throwing.
- **`src/server/http.ts`** — one `node:http` server: `GET /api/lineup`,
  `GET /api/waivers` → JSON; everything else served as a static file from
  `public/` (path-checked against traversal). Errors → `500 {error}`.
- **`src/cli/serve.ts`** (`npm run web`) — binds `0.0.0.0:$WEB_PORT` (default
  4173) so the tailnet can reach it.
- **`public/`** — `index.html` (two-panel shell), `app.js` (fetch + render,
  no framework), `style.css` (mobile-first, dark), `manifest.webmanifest` +
  `icon.svg` (installable), `sw.js` (caches the app shell; always network-first
  for `/api/*` so data is never served stale).

### Making it installable over the tailnet

Chrome/Android only offers "Add to Home Screen" on a secure context — a bare
`http://100.x.x.x:4173` tailnet address doesn't qualify. One-time setup on the
machine running `npm run web` (outside this repo, can't be scripted here):

```bash
tailscale serve https / 4173
```

This needs MagicDNS + HTTPS certificates enabled for the tailnet (a one-time
toggle in the Tailscale admin console, on by default for most personal
tailnets). It publishes a stable `https://<machine>.<tailnet>.ts.net` URL —
open that on the phone and "Add to Home Screen" becomes available.

## Verification

1. `npm run typecheck` — clean.
2. `npm run web`, then `curl localhost:4173/api/lineup` / `/api/waivers` —
   verified live against the real ESPN league: lineup panel correctly held
   A.J. Brown (IR, locked) in his WR slot with `"Lineup is already optimal"`;
   waivers panel returned real add/drop pairs (Deebo Samuel / Kenny Gainwell,
   Daniel Jones / C.J. Stroud) with reasons and net value.
3. Opened `http://localhost:4173` in a browser at a 375×812 mobile viewport —
   both panels render, refresh buttons re-fetch, styling holds up at phone
   width.

## Notes / open items

- First waivers load (before the LLM digest cache warms) is slow — it fans
  out over the whole free-agent pool. Cached afterwards (`.cache/llm-digest/`),
  same as the CLI.
- The `tailscale serve` HTTPS step is manual and one-time; this repo has no
  way to run it on the user's behalf.
- No new npm dependencies.

## Addendum — 2026-09-20: cosmetic slot swaps looked like real recommendations

Live bug: the dashboard showed a "Proposed changes" table for a pure
slot-label reshuffle between two players *already both starting* (e.g.
Ashton Jeanty RB<->W/R/T with Bucky Irving, same total points) — confusing,
since nothing actually needed submitting. `set-lineup.ts` has always guarded
this correctly via `diff.needsSubmit` (`LineupDiff.needsSubmit` is false
when the *set* of starters is unchanged, even if `changes` still lists the
label swaps), but `public/app.js`'s `renderLineup` only checked whether
`diff.changes.length` was nonzero, never `needsSubmit`. Fixed to branch on
`needsSubmit` exactly like the CLI, with the same "cosmetic slot swaps,
nothing to submit" wording when `changes` is non-empty but no real submit
is needed.

## Addendum — 2026-09-21: the service worker was hiding every future deploy

Live bug: after shipping the live/final score column, a `git pull` +
`docker compose up -d --build` on the NAS didn't make it appear — the
browser kept showing the old page indefinitely. Root cause: `sw.js` cached
the app shell (`app.js`, `index.html`, etc.) **cache-first** under a static
cache name (`ffl-shell-v1`) that never changed between deploys. Once a
browser had `app.js` cached, it never asked the server again — a rebuilt,
redeployed server was completely invisible to it. This defeats the entire
point of a live sports dashboard.

Fixed: the app shell is now **network-first** (`sw.js`), with the cache used
only as a genuine offline fallback when the network fetch fails — the same
policy `/api/*` already had. Also bumped the cache name to `ffl-shell-v2` so
the `activate` handler's existing cleanup (`caches.keys()` minus the current
`SHELL_CACHE`) actually evicts the old, wrong cache once this update lands
rather than silently reusing it.

**This fix requires an active step from anyone who already installed the
PWA**: since the OLD service worker is what decides whether to even notice
a new `sw.js`, a plain redeploy might still need a hard refresh (or fully
closing and reopening the installed app) once to pick up the fix. After
that, deploys should always show up on the next normal reload.
