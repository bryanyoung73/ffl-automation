# ESPN Fantasy API provider

Date: 2026-08-31
Status: approved

## Problem

Everything runs through a Playwright browser against Yahoo: a manual Chrome/CDP
login dance, a saved `storageState.json`, and hashed-class selectors that rotate
every deploy (the lineup selectors are still unverified). ESPN exposes the same
data as plain HTTPS JSON (the unofficial Fantasy v3 API) — no browser, no
scraping, stable field names. Move the four features to ESPN **without dropping
Yahoo**.

## Scope

**In:** A `LeagueProvider` interface the CLIs talk to, a Yahoo implementation
that wraps the existing page objects unchanged, and an ESPN implementation over
`fetch`. `PROVIDER` env var (`yahoo` default) selects one for every command.
Features: `cheatsheet`, `roster`, `lineup` (optimize + submit).

**Out:** Waiver/trade transactions, matchup/scoreboard reads, historical
seasons, retiring the Yahoo path. Offensive flex variants collapse to `W/R/T`.
IDP slots are recognised (LB/DL/DB/… kept as their own codes so nothing is
dropped) but IDP lineup optimization is unverified until the league drafts.

## Approach

Pure logic (`draft/board.ts`, `lineup/optimizer.ts`, `draft/report.ts`, the
`types.ts` shapes) is provider-agnostic and untouched — both providers emit the
same `BoardEntry` / `Player` / `LeagueSettings` / `RosterReadResult`. ESPN
JSON→domain mapping lives in **exported pure functions** (`mapSettings`,
`startingSlotCodes`, `mapRosterEntry`, `mapPlayerPoolEntry`, `buildLineupItems`)
so tests feed fixtures with no network; the class is fetch + call mapper.

## Modules

```
src/providers/
  types.ts              LeagueProvider interface (+ re-export RosterReadResult)
  index.ts              getProvider(config), providerLabel(config)
  yahoo/YahooLeague.ts   wraps browser.ts + pages/* — no behaviour change
  espn/
    client.ts            EspnClient: fetch wrapper, cookies, x-fantasy-filter
    maps.ts              PURE: id<->code maps, scoring + projection extractors
    EspnLeague.ts        provider impl + exported pure mappers
src/config.ts            provider field; Yahoo vars lazy; ESPN_* + EspnConfig
src/lineup/types.ts      now hosts RosterReadResult
tests/
  espn-maps.spec.ts      PURE map/scoring/projection/filter tests
  espn-league.spec.ts     fixture -> domain mapping + buildLineupItems
  fixtures/espn-league.sample.json   hand-built; replace with a real dump
```

## ESPN API

Read base:  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<season>/segments/0/leagues/<leagueId>`
Write base: `https://lm-api-writes.fantasy.espn.com/…/leagues/<leagueId>`
Auth (private league): `Cookie: espn_s2=<…>; SWID={<…>}`

| Need | Request | Yields |
| --- | --- | --- |
| Settings | `?view=mSettings` | `settings.size`, `rosterSettings.lineupSlotCounts`, `scoringSettings.scoringItems`, `draftSettings.type` |
| Draft board | `?view=kona_player_info` + `x-fantasy-filter` (limit 300, sortDraftRanks) | `players[].player`: `fullName`, `defaultPositionId`, `proTeamId`, `byeWeek`, `eligibleSlots`, `ownership.averageDraftPosition`, `draftRanksByRankType.{PPR,STANDARD}.rank` |
| Roster | `?view=mRoster&view=mSettings&forTeamId=<id>&scoringPeriodId=<wk>` | `teams[].roster.entries[]`: `playerId`, `lineupSlotId`, `playerPoolEntry.player` (+ `stats[]`) |
| Set lineup | `POST transactions/` | `{isLeagueManager:false, teamId, type:"ROSTER", memberId:SWID, scoringPeriodId, executionType:"EXECUTE", items:[{playerId,type:"LINEUP",fromLineupSlotId,toLineupSlotId}]}` |

### Id maps (`maps.ts`) — seeded from community `espn-api`, calibrate on first real dump

- **Pro team**: `0:FA,1:ATL,…,33:BAL,34:HOU`
- **Lineup slot → code**: `0:QB 2:RB 4:WR 6:TE 16:DEF 17:K 20:BN 21:IR`; flex
  variants (`3,5,7,23`) → `"W/R/T"`; IDP (`8:DT 9:DE 10:LB 11:DL 12:CB 13:S
  14:DB 15:DP`) keep their own codes
- **Position** (`defaultPositionId`): ESPN's scheme — `0/1:QB 2:RB 4:WR 6:TE
  17:K 16:DEF` + IDP. `derivePosition` prefers an unambiguous primary eligible
  slot and only falls back to this id.
- **Injury** → `PlayerStatus`: `ACTIVE→OK QUESTIONABLE→Q DOUBTFUL→D OUT→O
  INJURY_RESERVE→IR SUSPENSION→SUSP` (unknown → OK)
- **Scoring**: reception stat is `statId 53`; `points` `1→ppr 0.5→half-ppr
  else standard`. Picks `draftRanksByRankType` key `PPR` vs `STANDARD`.
- **Projection**: `stats[]` entry with `statSourceId === 1` (0 = actual);
  weekly = matching `scoringPeriodId`, season = `statSplitTypeId === 0`; value
  is `appliedTotal`.

### Lineup writes (`buildLineupItems`)

Optimizer plan → transaction items. Target slot code → representative slot id
(`QB:0 RB:2 WR:4 TE:6 K:17 DEF:16 W/R/T:23 BN:20`). `fromLineupSlotId` is the
player's current slot's rep id. Bench-outs (`to == 20`) are ordered before
promotions so the roster is valid mid-transaction. **The IR slot (21) is never
touched** — no auto add/drop to IR. `--dry-run` computes items and returns
without POSTing.

## Config

`PROVIDER` (`yahoo`|`espn`, default `yahoo`). Yahoo ids only required when
`provider === "yahoo"`. When `espn`: `ESPN_LEAGUE_ID`, `ESPN_TEAM_ID`,
`ESPN_SEASON` (default = current year), `ESPN_S2`, `ESPN_SWID` (braces
normalised). Week: `YAHOO_WEEK` or `ESPN_WEEK`, else the provider's current
scoring period. `Config` gains `provider` and an optional `espn: EspnConfig`.

## Testing

- `espn-maps.spec.ts` — every map, scoring detection, weekly/season projection
  split, `x-fantasy-filter` shape.
- `espn-league.spec.ts` — fixture → `LeagueSettings` / starting slot expansion /
  `Player` / `BoardEntry`; `buildLineupItems` promotes a benched over-projected
  player, never emits an IR move, empty once settled.
- Both added to `npm run test:unit`. No live ESPN calls in CI.

## Verification (needs the user's cookies)

1. `npm run typecheck`; `npm run test:unit` (all pure tests green).
2. `curl` the league with `?view=mSettings&view=mRoster&view=mTeam` → save as
   `tests/fixtures/espn-league.sample.json`, confirm the slot/position/team maps.
3. `PROVIDER=espn`: `npm run cheatsheet` (header says "ESPN"), `npm run roster`,
   `npm run lineup -- --dry-run`, then a real `npm run lineup`.
4. `PROVIDER=yahoo` regression: `cheatsheet` + `roster` unchanged.

## Notes

- ESPN's API is unofficial: no SLA, occasional shape drift, the write endpoint
  especially. `--dry-run` is the guard.

## Live verification — 2026-08-31, league 1144783883

Ran against the real league with the user's cookies.

- **`cheatsheet` works end to end.** 300 players, all with ADP; team/position/
  expert-rank mapping correct; flags sensible (Josh Jacobs, Jalen Hurts,
  Sam LaPorta). `output/cheatsheet-2026-08-31.{md,csv}` written.
- **`defaultPositionId` uses ESPN's own scheme** (`2` = RB, confirmed on
  Jahmyr Gibbs), *not* the `{1:QB,2:RB,3:WR,4:TE,5:K}` guess. `maps.ts` fixed;
  `derivePosition` still prefers the unambiguous eligible-slot derivation, so
  this only matters as a fallback.
- **`byeWeek` is absent from `kona_player_info` pre-season** → cheat-sheet Bye
  column is "—" for now. Expected to populate once the NFL schedule locks.
- **This is an IDP league.** `lineupSlotCounts` includes `10` (LB), `11` (DL),
  `14` (DB), each count 1; bench (`20`) is 4, IR (`21`) is 1. `maps.ts` /
  `STARTER_ORDER` / `REP_SLOT_ID` now carry the IDP slot codes so
  `startingSlotCodes` returns `… K, DEF, LB, DL, DB` instead of dropping them.
- **League has not drafted yet** (`scoringPeriodId: 0`, every `roster.entries`
  empty). `roster` / `lineup` therefore return nothing and can only be
  verified post-draft. IDP handling in the optimizer (defensive projections,
  whether ESPN even projects IDP weekly) is untested until then.
- CSV headers stay `yahoo_expert_pos` / `yahoo_gap` regardless of provider
  (structural; `tests/board.spec.ts` pins them). Rendered markdown/summary use
  the provider label.
