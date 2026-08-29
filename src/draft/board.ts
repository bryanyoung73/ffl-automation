import type { PlayerRef, Position } from "./types.js";

export interface BoardEntry {
  player: PlayerRef;
  /** Yahoo expert rank ("XRank"). */
  xRank: number | null;
  /** Average draft position. */
  adp: number | null;
  /** Position in Yahoo's current pre-rank list. */
  listRank: number;
}

export interface BoardRow {
  /** Our cheat-sheet order by ADP (1 = draft first). */
  rank: number;
  player: PlayerRef;
  adp: number | null;
  xRank: number | null;
  /** Position in Yahoo's pre-rank list. */
  listRank: number;
  /** Dense rank by Yahoo's expert rank (XRank), over the same player pool. */
  yahooExpertPos: number | null;
  /**
   * yahooExpertPos - rank. Positive: Yahoo's experts rank him lower than the
   * draft room (Yahoo cold / room high). Negative: Yahoo higher than the room.
   * null when the player has no XRank or no ADP.
   */
  yahooGap: number | null;
  /** Snake round bucket: ceil(rank / teams). */
  tier: number;
  note: "" | "yahoo-hot" | "yahoo-cold";
}

export interface Board {
  generatedAt: string;
  teams: number;
  threshold: number;
  positionFilter: Position | null;
  rows: BoardRow[];
  /** Count of rows where abs(yahooVsAdp) >= threshold. */
  disagreements: number;
  verdict: string;
}

export interface BuildBoardOptions {
  teams: number;
  /** abs(yahooExpertPos - boardRank) to call it a disagreement. Default 18. */
  threshold?: number;
  /**
   * Only flag disagreements inside the first N board slots — a 20-spot gap at
   * pick 12 matters, the same gap at pick 250 doesn't. Default teams * 12.
   */
  flagWithin?: number;
  /**
   * Flag K/DEF disagreements too. Off by default: Yahoo always ranks kickers and
   * defenses near the back regardless of ADP, so those gaps are structural noise.
   */
  flagKickersAndDefense?: boolean;
  position?: Position | null;
  now?: Date;
}

const NON_FLAGGED_POSITIONS: ReadonlySet<Position> = new Set(["K", "DEF"]);

/**
 * Turn the scraped pre-rank data into a printable draft board ordered by ADP
 * (falling back to XRank, then Yahoo's list order), bucketed into snake-round
 * tiers, and flagged where Yahoo's expert rank diverges from ADP.
 */
export function buildBoard(entries: readonly BoardEntry[], options: BuildBoardOptions): Board {
  const teams = Math.max(1, options.teams);
  const threshold = options.threshold ?? 18;
  const positionFilter = options.position ?? null;
  // Yahoo's XRank stops discriminating past ~pick 200 (it lumps deep players
  // into one low tier), so gaps out there are structural, not signal. Only flag
  // where both metrics are still ranking carefully — the first ~7 rounds.
  const flagWithin = options.flagWithin ?? teams * 7;

  const pool = positionFilter
    ? entries.filter((e) => e.player.position === positionFilter)
    : [...entries];

  // Dense rank by Yahoo's expert rank, so it's on the same 1..n scale as the
  // ADP-ordered board (raw XRank runs well past the player count).
  const expertPosById = new Map<string, number>();
  pool
    .filter((e) => e.xRank != null)
    .sort((a, b) => a.xRank! - b.xRank!)
    .forEach((e, i) => expertPosById.set(e.player.id, i + 1));

  const ordered = [...pool].sort((a, b) => sortKey(a) - sortKey(b));

  const rows: BoardRow[] = ordered.map((e, i) => {
    const rank = i + 1;
    const yahooExpertPos = expertPosById.get(e.player.id) ?? null;
    const yahooGap =
      e.adp != null && yahooExpertPos != null ? yahooExpertPos - rank : null;
    const flaggable =
      options.flagKickersAndDefense || !NON_FLAGGED_POSITIONS.has(e.player.position);
    let note: BoardRow["note"] = "";
    if (
      flaggable &&
      yahooGap != null &&
      rank <= flagWithin &&
      Math.abs(yahooGap) >= threshold
    ) {
      note = yahooGap > 0 ? "yahoo-cold" : "yahoo-hot";
    }
    return {
      rank,
      player: e.player,
      adp: e.adp,
      xRank: e.xRank,
      listRank: e.listRank,
      yahooExpertPos,
      yahooGap,
      tier: Math.ceil(rank / teams),
      note,
    };
  });

  const disagreements = rows.filter((r) => r.note !== "").length;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    teams,
    threshold,
    positionFilter,
    rows,
    disagreements,
    verdict: verdict(disagreements, rows.length),
  };
}

export function verdict(disagreements: number, total: number): string {
  if (total === 0) return "No players on the board.";
  if (disagreements === 0) {
    return "Yahoo's expert rank tracks ADP closely — the default board is fine as-is.";
  }
  if (disagreements <= 8) {
    return `Mostly aligned with ADP; ${disagreements} player${disagreements === 1 ? "" : "s"} where Yahoo's rank is off — check the flagged rows.`;
  }
  return `Yahoo's expert rank diverges from ADP on ${disagreements} players — worth a manual pass before you draft.`;
}

function sortKey(e: BoardEntry): number {
  return e.adp ?? e.xRank ?? e.listRank + 1000;
}
