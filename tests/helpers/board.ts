import type { Board, BoardRow } from "../../src/draft/board.js";
import type { PlayerRef, Position } from "../../src/draft/types.js";

/**
 * Shared fixture builders for the draft-engine specs. `BoardRow` has ~30 fields;
 * hand-rolling it in every spec means every new column touches every factory.
 * Point the local `row()` helpers at these instead — a new field is one edit.
 */

export function makeBoardRow(
  o: Partial<BoardRow> & { name?: string; position?: Position } = {},
): BoardRow {
  const rank = o.rank ?? 1;
  const player: PlayerRef =
    o.player ?? {
      id: o.name ?? `p${rank}`,
      name: o.name ?? `p${rank}`,
      position: o.position ?? "RB",
      team: "KC",
      bye: null,
    };
  return {
    rank,
    player,
    adp: o.adp ?? null,
    xRank: o.xRank ?? null,
    listRank: o.listRank ?? rank,
    yahooExpertPos: o.yahooExpertPos ?? null,
    yahooGap: o.yahooGap ?? null,
    ecrRank: o.ecrRank ?? null,
    ecrPosRank: o.ecrPosRank ?? null,
    ecrTier: o.ecrTier ?? null,
    ecrRankMin: o.ecrRankMin ?? null,
    ecrRankMax: o.ecrRankMax ?? null,
    ecrRankStd: o.ecrRankStd ?? null,
    adpHigh: o.adpHigh ?? null,
    adpLow: o.adpLow ?? null,
    adpStdev: o.adpStdev ?? null,
    tier: o.tier ?? 1,
    note: o.note ?? "",
    adpRank: o.adpRank ?? rank,
    blendShift: o.blendShift ?? 0,
    intel: o.intel,
    intelNote: o.intelNote ?? "",
    intelImpact: o.intelImpact ?? 0,
    adpChange: o.adpChange ?? null,
    adpTrend: o.adpTrend ?? "",
    vor: o.vor ?? null,
    vorRank: o.vorRank ?? null,
    vorGap: o.vorGap ?? null,
  };
}

export function makeBoard(rows: BoardRow[], o: Partial<Board> = {}): Board {
  return {
    generatedAt: o.generatedAt ?? "2026-01-01T00:00:00.000Z",
    teams: o.teams ?? 10,
    threshold: o.threshold ?? 18,
    positionFilter: o.positionFilter ?? null,
    sourceLabel: o.sourceLabel ?? "ESPN",
    expertLabel: o.expertLabel ?? "ECR",
    rows,
    disagreements: o.disagreements ?? 0,
    verdict: o.verdict ?? "",
    blended: o.blended ?? false,
    intelAsOf: o.intelAsOf ?? "",
  };
}
