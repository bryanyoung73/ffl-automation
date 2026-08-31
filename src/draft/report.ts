import type { Board, BoardRow } from "./board.js";
import type { CheatSheet, Override, Position } from "./types.js";

export interface RenderedBoard {
  markdown: string;
  csv: string;
  summary: string;
}

function noteLabels(src: string): Record<BoardRow["note"], string> {
  return {
    "": "",
    "yahoo-hot": `${src} ranks earlier than ADP`,
    "yahoo-cold": `${src} ranks later than ADP`,
  };
}

/** Printable draft board: tiers as sections, plus a flat CSV. */
export function renderBoard(board: Board): RenderedBoard {
  const src = board.sourceLabel || "Yahoo";
  const NOTE_LABEL = noteLabels(src);
  const scope = board.positionFilter ? ` — ${board.positionFilter}` : "";
  const lines: string[] = [
    `# Draft cheat sheet${scope}`,
    "",
    `_${board.generatedAt}_ · ${board.teams}-team · ordered by ADP (fallback ${src} rank)`,
    "",
    `**${board.verdict}**`,
    "",
  ];

  let currentTier = 0;
  for (const row of board.rows) {
    if (row.tier !== currentTier) {
      currentTier = row.tier;
      lines.push(
        "",
        `## Tier ${currentTier}  (picks ${(currentTier - 1) * board.teams + 1}–${currentTier * board.teams})`,
        "",
        `| # | Player | Pos | Team | Bye | ADP | ${src} | Flag |`,
        "| ---: | --- | --- | --- | ---: | ---: | ---: | --- |",
      );
    }
    lines.push(
      `| ${row.rank} | ${row.player.name} | ${row.player.position} | ${row.player.team} | ${row.player.bye ?? "—"} | ${fmt(row.adp)} | ${fmt(row.yahooExpertPos)} | ${NOTE_LABEL[row.note]} |`,
    );
  }

  return {
    markdown: lines.join("\n"),
    csv: boardCsv(board.rows),
    summary: boardSummary(board),
  };
}

function boardCsv(rows: BoardRow[]): string {
  const header =
    "rank,player,position,team,bye,adp,yahoo_expert_pos,yahoo_list_rank,xrank,yahoo_gap,tier,flag";
  const body = rows.map((r) =>
    [
      r.rank,
      csvField(r.player.name),
      r.player.position,
      r.player.team,
      r.player.bye ?? "",
      r.adp ?? "",
      r.yahooExpertPos ?? "",
      r.listRank,
      r.xRank ?? "",
      r.yahooGap ?? "",
      r.tier,
      r.note,
    ].join(","),
  );
  return [header, ...body].join("\n");
}

function boardSummary(board: Board): string {
  const src = board.sourceLabel || "Yahoo";
  const flagged = board.rows
    .filter((r) => r.note !== "")
    .sort((a, b) => Math.abs(b.yahooGap ?? 0) - Math.abs(a.yahooGap ?? 0))
    .slice(0, 12);
  const lines = [board.verdict];
  if (flagged.length) {
    lines.push("", `Where ${src}'s expert rank most disagrees with ADP (early picks):`);
    for (const r of flagged) {
      const dir = r.note === "yahoo-hot" ? `${src} higher` : `${src} lower`;
      lines.push(
        `  board #${r.rank} ${r.player.name} (${r.player.position}) — ADP ${fmt(r.adp)}, ${src} expert ~#${r.yahooExpertPos}  [${dir} by ${Math.abs(r.yahooGap ?? 0)}]`,
      );
    }
  }
  return lines.join("\n");
}

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? String(n) : "—";
}

export interface BuildCheatSheetInput {
  overrides: Override[];
  league: CheatSheet["league"];
  threshold: number;
  positionFilter: Position | null;
  now?: Date;
}

export function buildCheatSheet(input: BuildCheatSheetInput): CheatSheet {
  const undervalued = input.overrides.filter((o) => o.direction === "undervalued").length;
  const overvalued = input.overrides.filter((o) => o.direction === "overvalued").length;
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    league: input.league,
    thresholdUsed: input.threshold,
    positionFilter: input.positionFilter,
    overrides: input.overrides,
    counts: { undervalued, overvalued },
    verdict: verdict(input.overrides.length),
  };
}

export function verdict(count: number): string {
  if (count === 0) {
    return "Yahoo's default pre-rank is solid — no custom ranking needed.";
  }
  if (count <= 8) {
    return `Minor tweaks: ${count} player${count === 1 ? "" : "s"} worth overriding.`;
  }
  return `Worth building a custom pre-rank — ${count} meaningful gaps found.`;
}

export interface RenderedReport {
  markdown: string;
  csv: string;
  summary: string;
}

export function renderReport(sheet: CheatSheet): RenderedReport {
  return {
    markdown: renderMarkdown(sheet),
    csv: renderCsv(sheet.overrides),
    summary: renderSummary(sheet),
  };
}

function renderMarkdown(sheet: CheatSheet): string {
  const under = sheet.overrides.filter((o) => o.direction === "undervalued");
  const over = sheet.overrides.filter((o) => o.direction === "overvalued");
  const scope = sheet.positionFilter ? ` (${sheet.positionFilter} only)` : "";

  const lines: string[] = [
    `# Draft override sheet${scope}`,
    "",
    `_${sheet.generatedAt}_ · ${sheet.league.teams}-team ${sheet.league.scoring} ${sheet.league.draftType} · threshold ${sheet.thresholdUsed}`,
    "",
    `**${sheet.verdict}**`,
    "",
    `Undervalued by Yahoo (draft earlier): ${sheet.counts.undervalued} · Overvalued (let slide): ${sheet.counts.overvalued}`,
    "",
  ];

  if (under.length) {
    lines.push("## Draft earlier than Yahoo suggests", "", table(under), "");
  }
  if (over.length) {
    lines.push("## Let these slide", "", table(over), "");
  }
  if (!under.length && !over.length) {
    lines.push("_No overrides at this threshold._", "");
  }
  return lines.join("\n");
}

function table(rows: Override[]): string {
  const header =
    "| Player | Pos | Team | Bye | Yahoo | Consensus | Δ | ADP | VOR | ECR |\n" +
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows
    .map((o) => {
      const s = o.signals;
      return `| ${o.player.name} | ${o.player.position} | ${o.player.team} | ${o.player.bye ?? "—"} | ${o.yahooRank} | ${o.consensusRank} | ${fmtDelta(o.delta)} | ${num(s.adp)} | ${num(s.vor)} | ${num(s.ecr)} |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

function renderCsv(overrides: Override[]): string {
  const header = [
    "direction",
    "player",
    "position",
    "team",
    "bye",
    "yahoo_rank",
    "consensus_rank",
    "delta",
    "crosses_tier",
    "adp_rank",
    "vor_rank",
    "ecr_rank",
  ].join(",");
  const rows = overrides.map((o) =>
    [
      o.direction,
      csvField(o.player.name),
      o.player.position,
      o.player.team,
      o.player.bye ?? "",
      o.yahooRank,
      o.consensusRank,
      o.delta,
      o.crossesTier,
      o.signals.adp ?? "",
      o.signals.vor ?? "",
      o.signals.ecr ?? "",
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function renderSummary(sheet: CheatSheet): string {
  const top = sheet.overrides.slice(0, 10);
  const lines = [sheet.verdict];
  if (top.length) {
    lines.push("");
    for (const o of top) {
      const arrow = o.direction === "undervalued" ? "↑" : "↓";
      lines.push(
        `  ${arrow} ${o.player.name} (${o.player.position}) — Yahoo ${o.yahooRank}, consensus ${o.consensusRank} (Δ ${fmtDelta(o.delta)})`,
      );
    }
  }
  return lines.join("\n");
}

function fmtDelta(d: number): string {
  return d > 0 ? `+${d}` : `${d}`;
}
function num(n: number | undefined): string {
  return typeof n === "number" ? String(round1(n)) : "—";
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
