import type { CheatSheet, Override, Position } from "./types.js";

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
