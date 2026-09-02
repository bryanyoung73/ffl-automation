import type { PlayerRef, Position } from "./types.js";
import type { PlayerIntel } from "../intel/types.js";

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
  /** Rank by pure ADP order (== rank unless the board was blended). */
  adpRank: number;
  /** adpRank - rank: >0 means chatter bumped this player up. 0 when not blended. */
  blendShift: number;
  /** Chatter/news intel for this player, if any. */
  intel?: PlayerIntel;
  /** Newest intel note text, "" if none — for the rendered Note column. */
  intelNote: string;
  /** intel.seasonImpact, or 0. */
  intelImpact: number;
}

export interface Board {
  generatedAt: string;
  teams: number;
  threshold: number;
  positionFilter: Position | null;
  /** Data source name for rendered headers/labels, e.g. "Yahoo" or "ESPN". */
  sourceLabel: string;
  rows: BoardRow[];
  /** Count of rows where abs(yahooVsAdp) >= threshold. */
  disagreements: number;
  verdict: string;
  /** True when rows were reordered by chatter/news intel (`--blend`). */
  blended: boolean;
  /** ISO time the intel bundle was gathered, "" when no intel. */
  intelAsOf: string;
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
  /** Data source name for rendered headers/labels. Default "Yahoo". */
  sourceLabel?: string;
  /** Chatter/news intel keyed by player id. Attaches notes to every row. */
  intel?: ReadonlyMap<string, PlayerIntel>;
  /** Reorder the board by ADP shifted by each player's seasonImpact. */
  blend?: boolean;
  /** Board spots moved per point of seasonImpact when blending. Default teams * 0.6. */
  blendStrength?: number;
  /** ISO time the intel was gathered (for the rendered "as of" line). */
  intelAsOf?: string;
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
  const sourceLabel = options.sourceLabel ?? "Yahoo";
  // Yahoo's XRank stops discriminating past ~pick 200 (it lumps deep players
  // into one low tier), so gaps out there are structural, not signal. Only flag
  // where both metrics are still ranking carefully — the first ~7 rounds.
  const flagWithin = options.flagWithin ?? teams * 7;
  const intel = options.intel;
  const blend = options.blend ?? false;
  const blendStrength = options.blendStrength ?? teams * 0.6;

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

  // Pure ADP order first — gives every player an adpRank to measure blend moves against.
  const adpRankById = new Map<string, number>();
  [...pool]
    .sort((a, b) => sortKey(a) - sortKey(b))
    .forEach((e, i) => adpRankById.set(e.player.id, i + 1));

  const seasonImpact = (id: string): number => intel?.get(id)?.seasonImpact ?? 0;
  const effectiveKey = (e: BoardEntry): number =>
    blend ? sortKey(e) - seasonImpact(e.player.id) * blendStrength : sortKey(e);

  const ordered = [...pool].sort((a, b) => effectiveKey(a) - effectiveKey(b));

  const rows: BoardRow[] = ordered.map((e, i) => {
    const rank = i + 1;
    const rowIntel = intel?.get(e.player.id);
    const adpRank = adpRankById.get(e.player.id) ?? rank;
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
      adpRank,
      blendShift: blend ? adpRank - rank : 0,
      intel: rowIntel,
      intelNote: rowIntel?.notes[0]?.text ?? "",
      intelImpact: rowIntel?.seasonImpact ?? 0,
    };
  });

  const disagreements = rows.filter((r) => r.note !== "").length;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    teams,
    threshold,
    positionFilter,
    sourceLabel,
    rows,
    disagreements,
    verdict: verdict(disagreements, rows.length, sourceLabel),
    blended: blend,
    intelAsOf: options.intelAsOf ?? "",
  };
}

export function verdict(disagreements: number, total: number, sourceLabel = "Yahoo"): string {
  if (total === 0) return "No players on the board.";
  if (disagreements === 0) {
    return `${sourceLabel}'s expert rank tracks ADP closely — the default board is fine as-is.`;
  }
  if (disagreements <= 8) {
    return `Mostly aligned with ADP; ${disagreements} player${disagreements === 1 ? "" : "s"} where ${sourceLabel}'s rank is off — check the flagged rows.`;
  }
  return `${sourceLabel}'s expert rank diverges from ADP on ${disagreements} players — worth a manual pass before you draft.`;
}

function sortKey(e: BoardEntry): number {
  return e.adp ?? e.xRank ?? e.listRank + 1000;
}
