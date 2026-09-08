import { resolve } from "node:path";
import type { Config, SleeperConfig } from "../../config.js";
import type { BoardEntry } from "../../draft/board.js";
import type { LeagueSettings } from "../../draft/types.js";
import type { LineupPlan } from "../../lineup/types.js";
import type { DraftState, LeagueProvider, RosterReadResult } from "../types.js";
import { SleeperClient } from "./client.js";
import {
  buildStarters,
  detectScoring,
  mapDraftState,
  mapFreeAgent,
  mapRoster,
  mapSettings,
  playerUniverse,
  startingSlotCodes,
  type SleeperDraftRaw,
  type SleeperLeagueRaw,
  type SleeperPickRaw,
  type SleeperRosterRaw,
  type StatBundle,
} from "./maps.js";
import { attachAdp, fetchAdp } from "../../draft/adp.js";
import {
  fetchSleeperProjections,
  fetchSleeperSeasonStats,
  fetchSleeperWeeklyProjections,
} from "./projections.js";
import { loadSleeperPlayers } from "../../intel/match.js";
import type { SleeperPlayer } from "../../intel/match.js";
import type { FreeAgent } from "../../waivers/types.js";

/**
 * Sleeper provider — reads only, no auth. Phase 1: league settings, the live
 * draft feed (`getDraftState`, incl. my slot), and an ADP-ordered draft board.
 * Roster / free agents / lineup writes come in later phases and throw for now.
 */
export class SleeperLeague implements LeagueProvider {
  private readonly client: SleeperClient;
  private readonly cfg: SleeperConfig;
  private readonly cacheDir: string;
  private resolvedUserId: string | null;
  private draftIdCache: string | undefined;
  private myRosterIdCache: number | undefined;

  constructor(config: Config) {
    if (!config.sleeper) {
      throw new Error("SleeperLeague requires PROVIDER=sleeper config (missing SLEEPER_* env vars).");
    }
    this.cfg = config.sleeper;
    this.cacheDir = resolve(config.projectRoot, ".cache");
    this.client = new SleeperClient(config.sleeper);
    this.resolvedUserId = config.sleeper.userId;
  }

  async getLeagueSettings(): Promise<LeagueSettings> {
    const draft = await this.draft();
    // A mock draft (SLEEPER_DRAFT_ID, or a draft whose league is gone) has no
    // league resource — derive settings from the draft's own slots_* counts.
    const league =
      this.cfg.leagueId && !this.cfg.draftId ? await this.league() : null;
    return mapSettings(league, draft);
  }

  async getDraftState(): Promise<DraftState> {
    const id = await this.draftId();
    const [draft, picks, uid] = await Promise.all([
      this.client.get<SleeperDraftRaw>(`draft/${id}`, { noCache: true }),
      this.client.get<SleeperPickRaw[]>(`draft/${id}/picks`, { noCache: true }),
      this.userId(),
    ]);
    return mapDraftState(draft, picks, uid);
  }

  async getDraftBoard(): Promise<BoardEntry[]> {
    const [settings, dump] = await Promise.all([
      this.getLeagueSettings(),
      loadSleeperPlayers(this.cacheDir),
    ]);
    const scoring = settings.scoring;
    const teams = settings.teams || 10;

    const universe = playerUniverse(dump);
    const [adp, proj] = await Promise.all([
      fetchAdp(this.cacheDir, scoring, teams, this.cfg.season),
      fetchSleeperProjections(this.cacheDir, this.cfg.season, scoring),
    ]);
    const { entries } = attachAdp(universe, adp);

    return entries
      .filter((e) => e.adp != null)
      .sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999))
      .map((e, i) => ({
        ...e,
        listRank: i + 1,
        projectedPoints: proj.get(e.player.id) ?? null,
      }));
  }

  async getRoster(week?: number): Promise<RosterReadResult> {
    const leagueId = this.requireLeague("Roster reads");
    const [league, mine, dump, wk] = await Promise.all([
      this.league(),
      this.myRoster(leagueId),
      loadSleeperPlayers(this.cacheDir),
      week != null ? Promise.resolve(week) : this.currentWeek(),
    ]);

    const scoring = detectScoring(league.scoring_settings);
    const positions = league.roster_positions ?? [];
    const byId = new Map(dump.map((p) => [p.player_id, p]));
    const pts = await this.statBundle(scoring, wk);

    return {
      players: mapRoster(mine, positions, byId, pts),
      startingSlotCodes: startingSlotCodes(positions),
    };
  }

  async getFreeAgents(week?: number): Promise<FreeAgent[]> {
    const leagueId = this.requireLeague("Waiver-wire analysis");
    const [league, rosters, dump, wk, trending] = await Promise.all([
      this.league(),
      this.client.get<SleeperRosterRaw[]>(`league/${leagueId}/rosters`),
      loadSleeperPlayers(this.cacheDir),
      week != null ? Promise.resolve(week) : this.currentWeek(),
      this.client
        .get<Array<{ player_id: string; count: number }>>(
          `players/nfl/trending/add?lookback_hours=24&limit=300`,
        )
        .catch(() => [] as Array<{ player_id: string; count: number }>),
    ]);

    const rostered = new Set<string>();
    for (const r of rosters) for (const p of r.players ?? []) if (p) rostered.add(p);
    const trend = new Map(trending.map((t) => [t.player_id, t.count]));

    const scoring = detectScoring(league.scoring_settings);
    const pts = await this.statBundle(scoring, wk);

    const fas: FreeAgent[] = [];
    for (const sp of dump as SleeperPlayer[]) {
      const pos = (sp.position ?? "").toUpperCase();
      if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
      if (sp.active === false && pos !== "DEF") continue;
      if (rostered.has(sp.player_id)) continue;
      const fa = mapFreeAgent(sp, pts, trend.get(sp.player_id) ?? 0);
      // keep the pool tight: only players with a real season projection
      if (fa.seasonProj <= 0 && (trend.get(sp.player_id) ?? 0) === 0) continue;
      fas.push(fa);
    }
    fas.sort((a, b) => b.seasonProj - a.seasonProj || b.pctChange - a.pctChange);
    return fas.slice(0, 250);
  }

  async applyLineup(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void> {
    const leagueId = this.requireLeague("Lineup writes");
    const starters = buildStarters(plan);

    if (opts.dryRun) {
      console.log(`  [dry-run] would set starters (${starters.length}): ${starters.join(", ")}`);
      return;
    }

    const rosterId = this.myRosterIdCache ?? (await this.myRoster(leagueId)).roster_id;
    if (rosterId == null) throw new Error("Could not resolve my Sleeper roster_id.");

    // Sleeper's authenticated GraphQL — the same mutation the web app uses to
    // save a lineup. `starters` is a JSON-encoded array of player ids. UNVERIFIED
    // against a live submit (needs a token); eyeball a --dry-run first.
    await this.client.graphql(
      `mutation SetStarters($league_id: Snowflake, $roster_id: Int, $starters: String) {
         roster_update_starters(league_id: $league_id, roster_id: $roster_id, starters: $starters) {
           roster_id
         }
       }`,
      { league_id: leagueId, roster_id: rosterId, starters: JSON.stringify(starters) },
    );
  }

  async close(): Promise<void> {
    /* stateless HTTP client — nothing to release. */
  }

  /* ---------------------------------------------------------------- */

  private requireLeague(what: string): string {
    if (!this.cfg.leagueId) {
      throw new Error(
        `${what} on Sleeper needs SLEEPER_LEAGUE_ID — a mock draft (SLEEPER_DRAFT_ID) ` +
          `has no roster.`,
      );
    }
    return this.cfg.leagueId;
  }

  private async currentWeek(): Promise<number> {
    const s = await this.client.get<{ week?: number; display_week?: number }>("state/nfl");
    return s.display_week ?? s.week ?? 1;
  }

  private async statBundle(
    scoring: LeagueSettings["scoring"],
    week: number,
  ): Promise<StatBundle> {
    const [wk, season, actual] = await Promise.all([
      fetchSleeperWeeklyProjections(this.cacheDir, this.cfg.season, week, scoring),
      fetchSleeperProjections(this.cacheDir, this.cfg.season, scoring),
      fetchSleeperSeasonStats(this.cacheDir, this.cfg.season, scoring),
    ]);
    return { week: wk, season, actual };
  }

  /** My roster in the league, found by `owner_id`. */
  private async myRoster(leagueId: string): Promise<SleeperRosterRaw> {
    const [rosters, uid] = await Promise.all([
      this.client.get<SleeperRosterRaw[]>(`league/${leagueId}/rosters`),
      this.userId(),
    ]);
    if (!uid) {
      throw new Error("Set SLEEPER_USERNAME (or SLEEPER_USER_ID) so I know which roster is yours.");
    }
    const mine = rosters.find((r) => r.owner_id === uid);
    if (!mine) throw new Error(`No Sleeper roster owned by ${uid} in league ${leagueId}.`);
    if (mine.roster_id != null) this.myRosterIdCache = mine.roster_id;
    return mine;
  }

  private async userId(): Promise<string | null> {
    if (this.resolvedUserId) return this.resolvedUserId;
    if (!this.cfg.username) return null;
    const u = await this.client.get<{ user_id?: string }>(`user/${this.cfg.username}`);
    this.resolvedUserId = u.user_id ?? null;
    return this.resolvedUserId;
  }

  private league(): Promise<SleeperLeagueRaw> {
    if (!this.cfg.leagueId) {
      throw new Error("SLEEPER_LEAGUE_ID is not set (running against a bare draft id).");
    }
    return this.client.get<SleeperLeagueRaw>(`league/${this.cfg.leagueId}`);
  }

  private async draftId(): Promise<string> {
    if (this.cfg.draftId) return this.cfg.draftId;
    if (this.draftIdCache) return this.draftIdCache;
    const league = await this.league();
    if (league.draft_id) {
      this.draftIdCache = league.draft_id;
      return league.draft_id;
    }
    const drafts = await this.client.get<Array<{ draft_id: string; created?: number }>>(
      `league/${this.cfg.leagueId}/drafts`,
    );
    const newest = [...drafts].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    if (!newest) throw new Error(`Sleeper league ${this.cfg.leagueId} has no draft.`);
    this.draftIdCache = newest.draft_id;
    return newest.draft_id;
  }

  private async draft(): Promise<SleeperDraftRaw> {
    return this.client.get<SleeperDraftRaw>(`draft/${await this.draftId()}`);
  }
}
