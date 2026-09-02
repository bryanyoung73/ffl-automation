# Player intel: a shared chatter/news signal for draft + weekly

Date: 2026-09-02
Status: shipped (Phases 1–4)

## Problem

The draft cheat sheet ranks purely on ADP vs the platform's expert rank. The
weekly lineup optimizer ranks purely on the platform's projected points. Neither
sees what's actually being said about a player right now — injury and practice
status, depth-chart moves, coach/player quotes, camp buzz. We want one signal
that captures that "internet chatter" and feeds **both** pipelines.

## Scope

**In:** A provider-agnostic `src/intel/` module producing `PlayerIntel` per
player (numeric impact + human-readable notes + freshness), consumed by:
- the draft cheat sheet (`buildBoard`) — annotate, optionally re-score
- the weekly path (`show-roster`, `set-lineup`) — adjust effective projected
  points before the optimizer runs

**Out (for now):** trade/waiver advice, multi-week projections, a hosted UI.
LLM-derived notes are Phase 3.

## Key idea: horizon-weighted impact

The same raw fact carries different weight by context:
- **Draft** cares about season-long outlook — role, holdout, durability, camp.
  An injury *today* barely matters (months to heal).
- **Weekly** cares about this-week availability — practice participation
  (DNP/LP/FP), Friday game-status designation, weather, snap-count trend.
  Long-term role stuff matters less.

So every note is tagged `horizon: "season" | "week" | "both"`, and the provider
emits both `seasonImpact` and `weekImpact` (−3..+3). Each consumer uses the one
it needs.

## Shapes

```ts
interface IntelNote {
  text: string;              // "DNP Wed/Thu; coach called him day-to-day"
  source: string;            // "sleeper" | "espn-news" | "nfl-injury" | ...
  url?: string;
  horizon: "season" | "week" | "both";
  asOf: string;              // ISO timestamp
}

interface PlayerIntel {
  playerKey: string;         // normalized identity (see Matching)
  notes: IntelNote[];
  seasonImpact: number;      // -3..+3
  weekImpact: number;        // -3..+3
  confidence: number;        // 0..1
  asOf: string;              // newest note timestamp
}

interface IntelProvider {
  name: string;
  collect(ctx: { players: PlayerRef[]; week: number }): Promise<Map<string, Partial<PlayerIntel>>>;
}
```

## Modules

```
src/intel/
  types.ts        PlayerIntel, IntelNote, IntelProvider
  match.ts        cross-provider player identity — Sleeper's dump ships espn_id
                  + yahoo_id, so build name+team+pos -> sleeper_id once and use
                  that as the join key for every source
  providers/
    sleeper.ts        injury_status, practice_participation, injury_body_part,
                      trending adds                              [week + season]
    espnNews.ts       site.api.espn.com/apis/fantasy/v3/games/ffl/news/players  [both]
    injuryReport.ts   official NFL practice + game designation   [week]
    vegas.ts          implied team total / spread                [week]
    newsDigest.ts     LLM over beat-writer blurbs -> structured  [both]  (Phase 3)
  collect.ts      run enabled providers, merge, cache to
                  .cache/intel-<season>-wk<week>.json (short TTL during game week)
  apply.ts        PURE:
                    annotateBoard(entries, intel)      -> BoardEntry[] + notes
                    adjustProjections(players, intel, {horizon:"week"})
                                                       -> Player[] (points nudged) + notes
```

`collect.ts` / providers are the only impure part. `match.ts` and `apply.ts`
stay pure and fixture-tested. LLM output is cached to disk so a run is
reproducible and cheap.

## Wiring

- `cli/cheatsheet.ts`: after `provider.getDraftBoard()`, `annotateBoard(entries,
  intel)`; `buildBoard` gains an optional `intel` input, renders a Notes column,
  and with `--blend` composes an `adjustedRank` via the existing
  `draft/diff.ts` / `Override` machinery.
- `cli/show-roster.ts` + `cli/set-lineup.ts`: after `provider.getRoster()`,
  `adjustProjections(players, intel, { horizon: "week" })`, then optimize as
  today. Print each adjustment + reason
  (`Kelce  14.2 -> 11.0  · DNP Wed/Thu`). `--dry-run` still shows everything and
  submits nothing.
- New `npm run intel` — preview / force-refresh the cache.
- `--no-intel` on every command — bypass entirely.
- Both outputs carry an "intel as of <timestamp>" line.

## Re-score vs annotate (decided)

- **Draft board:** annotate-only by default (you draft live and want the note,
  not a silently reordered board). `--blend` opts into re-scoring.
- **Weekly:** fold into the projection — that's the point of an automated
  optimizer. The printed deltas + `--dry-run` keep it auditable. Optionally feed
  the optimizer's existing `pinnedPlayerIds` as *soft* warnings.

## Phases

1. **`intel/` core + `match.ts` + `sleeper.ts` + `espnNews.ts` + `collect.ts`
   cache, wired into the weekly path.** (~1.5–2 days) Lead here — structured
   injury/practice data is the highest-value, most deterministic piece and it's
   most useful week to week.
2. **Wire the same intel into the draft board** — Notes column + optional
   `--blend`. (~0.5–1 day)
3. **`newsDigest.ts`** — LLM digest of coach/player quotes → structured notes
   with citations, for both pipelines. (~1–2 days + API key + per-run cost)
4. **`vegas.ts` + weather** as weekly projection inputs. (~1 day)

## Testing

- `match.spec.ts` — name/team/pos normalization, Sleeper id join, unmatched
  players pass through untouched.
- `apply.spec.ts` — `adjustProjections` nudges by `weekImpact` only, clamps,
  leaves un-intel'd players alone; `annotateBoard` attaches notes without
  reordering unless asked.
- Provider specs run against saved fixtures (no live calls in CI).
- LLM digest: fixture-in / JSON-out, schema-validated; never asserts on prose.

## Open items

- Beat-writer text source: RotoWire/FantasyPros API ($) vs scraping (fragile,
  ToS). Phase 3 decision.
- Impact scoring: hand-rules per signal type first; revisit a learned weighting
  only if the hand-rules feel off after a few weeks.
- Cache TTL tuning during game week (practice reports land Wed–Fri).

---

## Addendum — Phase 1 shipped (2026-09-02)

Built: `src/intel/` (`types.ts`, `cache.ts`, `match.ts`, `apply.ts`,
`collect.ts`, `weekly.ts`, `providers/sleeper.ts`, `providers/espnNews.ts`),
`src/cli/intel.ts` (`npm run intel`), wired into `roster` + `lineup` via
`applyWeeklyIntel`. `--no-intel` / `--refresh` on all three. Bundle cached to
`.cache/intel-<season>-wk<week>.json` (6 h TTL); the Sleeper player dump to
`.cache/sleeper-players.json` (24 h). 22 unit tests (match / apply / espn-news).

Verified live against Sleeper + ESPN news for real players:
- **Sleeper is the workhorse.** `injury_status` + `injury_body_part` +
  `practice_participation` + `injury_notes` + trending adds all flow. Name+team
  join hit every skill player tried.
- **ESPN news is noisy.** Half the "player news" feed is roundup articles
  ("Do Draft list", "sleepers & breakouts") that only mention the player.
  Fixed with `isPlayerBlurb()` — impact only scores when the headline *leads*
  with the player's surname (beat-writer style); roundups become notes-only.
  Even so, keyword scoring stays deliberately timid — real extraction is
  Phase 3.
- Net effect example: Mahomes "Questionable (knee)" from Sleeper (−0.7) + an
  ESPN blurb "on track to start Week 1" (+0.7) → net 0 week adjustment, +0.2
  season. Reads right.

Not done at Phase 1: draft-board wiring, LLM digest (Phase 3), Vegas/weather
(Phase 4). Couldn't exercise the full `roster`/`lineup` path end to end — the
ESPN league hadn't drafted and no Yahoo `.auth` session in this checkout; the
pieces are unit-tested and the `collectIntel` path was probed directly.

## Addendum — Phase 2 shipped (2026-09-02)

Draft board wired.

- `buildBoard` takes `intel` (map) + `blend` + `blendStrength` + `intelAsOf`.
  Every row gets `adpRank`, `blendShift`, `intel`, `intelNote`, `intelImpact`.
  `--blend` re-sorts by `sortKey(e) - seasonImpact * (teams * 0.6)` — a ±3
  buy/fade ≈ ±2 rounds — and records the move.
- `renderBoard`: a `Chatter` column (impact tag + top note, truncated) on every
  tier table; a `Δ` column and "ordered by ADP blended with chatter" header only
  when blended; a `Chatter:` block in the console summary; CSV gains
  `adp_rank, blend_shift, intel_season, intel_week, intel_note, intel_sources`.
- `cheatsheet.ts`: `--blend`, `--no-intel`, `--intel-depth <n>` (default
  `teams * 8` — only the draftable range is worth fetching news for),
  `--refresh`. Intel uses `collectIntel(..., { scope: "draft" })` so its thin
  top-N bundle never overwrites the weekly roster bundle.
- `espnNews` tightened: a blurb is kept only if it's name-led **and**
  `isActionable` (availability/usage words) — opinion/roundup pieces
  ("bold predictions", "fantasy red flag") are dropped as note and signal.

Verified live: `PROVIDER=espn npm run cheatsheet --blend --intel-depth 60`
against league 1144783883. 56/60 players got notes; Tyler Warren
"Questionable (Groin)" → −1 season → ▼6; trending adds and practice-return
blurbs produce small +0.2–0.4 bumps. 71 unit tests (+ `board-intel.spec.ts`,
`isActionable`).

Known limitation carried to Phase 3: the displayed note is the newest, which
isn't always the one that moved the number; keyword scoring is coarse. The LLM
digest replaces both.

## Addendum — Phase 3 shipped (2026-09-02)

LLM news digest, opt-in.

- `providers/espnNewsFeed.ts` — shared fetch/filter (`fetchPlayerNews`,
  `isPlayerBlurb`, `isActionable`). `espnNews` and `newsDigest` both read it.
- `providers/newsDigest.ts` — for each player, sends the actionable blurbs to
  Claude via a forced `record_intel` tool (`{week_impact, season_impact,
  confidence, summary}`, all range-checked in the pure `parseDigest`). The
  summary becomes note[0] (`source: "llm-digest"`); the raw blurbs follow. The
  summary is the fix for "displayed note isn't the one that moved the number".
  `buildDigestInput` / `parseDigest` are pure and unit-tested; no live call in
  CI. Concurrency capped at 5.
- Per-player result cached to `.cache/llm-digest/<espnId>-<sha1(blurbs)>.json`
  (7-day TTL). Content-addressed, so `--refresh` only re-calls players whose
  news actually changed.
- Opt-in: `--llm` flag on `cheatsheet` / `roster` / `lineup` / `intel`, or
  `INTEL_LLM=1`. `INTEL_LLM_MODEL` defaults to `claude-opus-5`
  (`collectIntel({ llm })` swaps `espnNews` -> `newsDigest`; bundle cache tag
  `-llm` keeps the two apart). Missing `ANTHROPIC_API_KEY` -> one warning, falls
  back to Sleeper-only (verified live). `@anthropic-ai/sdk` added as a dep.
- 75 unit tests (+ `intel-news-digest.spec.ts`).

Not verified live — no Anthropic key in this checkout. The prompt, tool schema,
parse/clamp, caching, concurrency, provider swap, and graceful no-key
degradation are all unit-tested / smoke-tested; the actual model call and its
output quality are the user's to confirm (`--llm` on a real key). Expect prompt
tuning after the first real batch.

## Addendum — Phase 4 shipped (2026-09-02)

Vegas game context as a weekly signal.

- `providers/vegas.ts` — pulls the ESPN public NFL scoreboard for the target
  week (free, no key). `impliedTotals(ou, homeSpread)` splits the O/U by the
  spread; `parseScoreboard` yields a `GameContext` per team (both sides of each
  game — favorite spread negated for the road team). `vegasImpact({position,
  impliedTotal, opponentImpliedTotal, spread, weatherBadness})`:
  - base: `(impliedTotal - 22) * 0.13`, clamped ±2
  - game script: fav by 7+ → RB +0.3 / pass-catchers −0.15; dog by 7+ →
    WR/TE +0.3, QB +0.15, RB −0.3
  - weather (`weatherBadness` 0/1/2 from `event.weather.displayValue` + temp):
    K −0.4/−0.8, QB/WR/TE −0.25/−0.5, RB +0.1
  - DEF inverts — it wants a LOW opponent total; bad weather helps
  - notes: `"Implied total 28.3 (DET -7 vs NO, O/U 49.5)"` + a weather note
- Week-only: `collectIntel` runs it whenever `scope !== "draft"`; the draft
  board (which only reads `seasonImpact`) skips the fetch.
- All three pure fns unit-tested (`intel-vegas.spec.ts`). 81 unit tests total.

Verified live against the ESPN scoreboard: implied totals compute correctly
(KC -3 vs DEN → 22.8; DET -7 → 28.3), game-script and position nuance apply,
neutral matchups land near zero.

## Status

All four phases shipped. The full weekly stack: Sleeper (injury/practice) +
news (keyword or `--llm` digest) + Vegas → adjusted projections into the
optimizer. Draft: Sleeper + news → Chatter column / `--blend`. Live-verified
except the exact model output quality of the LLM digest, which depends on the
user's key and prompt tuning.
