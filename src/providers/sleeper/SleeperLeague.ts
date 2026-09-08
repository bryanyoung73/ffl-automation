import { resolve } from "node:path";
import type { Config, SleeperConfig } from "../../config.js";
import type { BoardEntry } from "../../draft/board.js";
import type { LeagueSettings } from "../../draft/types.js";
import type { LineupPlan } from "../../lineup/types.js";
import type { DraftState, LeagueProvider, RosterReadResult } from "../types.js";
import { SleeperClient } from "./client.js";
import {
  mapDraftState,
  mapSettings,
  playerUniverse,
  type SleeperDraftRaw,
  type SleeperLeagueRaw,
  type SleeperPickRaw,
} from "./maps.js";
import { attachAdp, fetchAdp } from "../../draft/adp.js";
import { loadSleeperPlayers } from "../../intel/match.js";

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
    const adp = await fetchAdp(this.cacheDir, scoring, teams, this.cfg.season);
    const { entries } = attachAdp(universe, adp);

    return entries
      .filter((e) => e.adp != null)
      .sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999))
      .map((e, i) => ({ ...e, listRank: i + 1 }));
  }

  getRoster(): Promise<RosterReadResult> {
    throw notSupported("Roster reads");
  }

  getFreeAgents(): Promise<never> {
    throw notSupported("Waiver-wire analysis");
  }

  applyLineup(_plan: LineupPlan, _opts: { dryRun: boolean }): Promise<void> {
    throw notSupported("Lineup writes");
  }

  async close(): Promise<void> {
    /* stateless HTTP client — nothing to release. */
  }

  /* ---------------------------------------------------------------- */

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

function notSupported(what: string): Error {
  return new Error(
    `${what} on Sleeper is not built yet (phase 3+). Use PROVIDER=espn for that, ` +
      `or see docs/specs/2026-09-08-sleeper-provider.md.`,
  );
}
