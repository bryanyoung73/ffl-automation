import type { Config } from "../../config.js";
import type { BoardEntry } from "../../draft/board.js";
import type { LeagueSettings } from "../../draft/types.js";
import type { LineupPlan } from "../../lineup/types.js";
import { openSession, type Session } from "../../browser.js";
import { LeagueSettingsPage } from "../../pages/LeagueSettingsPage.js";
import { DraftRankingsPage } from "../../pages/DraftRankingsPage.js";
import { LineupPage } from "../../pages/LineupPage.js";
import type { LeagueProvider, RosterReadResult } from "../types.js";

/**
 * Yahoo provider: the original Playwright path, behind the LeagueProvider
 * interface. Opens one browser session lazily and reuses it.
 */
export class YahooLeague implements LeagueProvider {
  private session: Session | undefined;

  constructor(private readonly config: Config) {}

  private async ensureSession(): Promise<Session> {
    if (!this.session) this.session = await openSession(this.config);
    return this.session;
  }

  async getLeagueSettings(): Promise<LeagueSettings> {
    const { page } = await this.ensureSession();
    return new LeagueSettingsPage(page, this.config).read();
  }

  async getDraftBoard(): Promise<BoardEntry[]> {
    const { page } = await this.ensureSession();
    const preRank = await new DraftRankingsPage(page, this.config).readPreRank();
    return preRank.map((p) => ({
      player: { id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye },
      xRank: p.xRank,
      adp: p.adp,
      listRank: p.listRank,
    }));
  }

  async getRoster(): Promise<RosterReadResult> {
    const { page } = await this.ensureSession();
    const lineup = new LineupPage(page, this.config);
    await lineup.goto();
    return lineup.readRoster();
  }

  async applyLineup(plan: LineupPlan, opts: { dryRun: boolean }): Promise<void> {
    const { page } = await this.ensureSession();
    const lineup = new LineupPage(page, this.config);
    await lineup.goto();
    await lineup.applyPlan(plan, opts);
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = undefined;
    }
  }
}
