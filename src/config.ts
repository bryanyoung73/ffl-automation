import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ensure a .env exists (copying from env.example the first time), then load it.
 * Safe to call more than once.
 */
function loadEnv(): void {
  const envPath = resolve(projectRoot, ".env");
  const examplePath = resolve(projectRoot, "env.example");
  if (!existsSync(envPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.log("Created .env from env.example — edit it if your league/team differ.");
  }
  dotenv.config({ path: envPath });
}

loadEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var ${name}. Set it in .env (see env.example).`);
  }
  return value.trim();
}

function optionalInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got "${raw}".`);
  return n;
}

export type Provider = "yahoo" | "espn";

export interface EspnConfig {
  leagueId: string;
  teamId: number;
  season: number;
  /** espn_s2 cookie value (private leagues). */
  s2: string;
  /** SWID cookie value, normalised to include the surrounding braces. */
  swid: string;
  readBaseUrl: string;
  writeBaseUrl: string;
}

export interface Config {
  /** Which data source every command talks to. */
  provider: Provider;
  leagueId: string;
  teamId: string;
  baseUrl: string;
  headless: boolean;
  storageStatePath: string;
  week: number | undefined;
  projectRoot: string;
  /** Absolute URL of the team's home page (Yahoo). */
  teamUrl: string;
  /** Absolute URL of the editable lineup page (Yahoo, optionally week-pinned). */
  lineupUrl: string;
  /** Where CLI output and debug dumps go (gitignored). */
  outputDir: string;
  /** Draft-prep pages (Yahoo). */
  leagueSettingsUrl: string;
  preRankUrl: string;
  /** Default abs(rank) gap to flag a draft-board disagreement. */
  overrideThreshold: number;
  /** Present only when provider === "espn". */
  espn?: EspnConfig;
}

function readProvider(): Provider {
  const raw = (process.env.PROVIDER?.trim() || "yahoo").toLowerCase();
  if (raw !== "yahoo" && raw !== "espn") {
    throw new Error(`PROVIDER must be "yahoo" or "espn", got "${raw}".`);
  }
  return raw;
}

/** SWID must carry its braces in the Cookie header; add them if the user pasted it bare. */
function normalizeSwid(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const inner = trimmed.replace(/^\{|\}$/g, "");
  return `{${inner}}`;
}

function loadEspnConfig(): EspnConfig {
  const leagueId = required("ESPN_LEAGUE_ID");
  const teamId = optionalInt("ESPN_TEAM_ID");
  if (teamId === undefined) {
    throw new Error(`Missing required env var ESPN_TEAM_ID. Set it in .env (see env.example).`);
  }
  const season = optionalInt("ESPN_SEASON") ?? new Date().getFullYear();
  const s2 = required("ESPN_S2");
  const swid = normalizeSwid(required("ESPN_SWID"));
  const root = `apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  return {
    leagueId,
    teamId,
    season,
    s2,
    swid,
    readBaseUrl: `https://lm-api-reads.fantasy.espn.com/${root}`,
    writeBaseUrl: `https://lm-api-writes.fantasy.espn.com/${root}`,
  };
}

export function loadConfig(): Config {
  const provider = readProvider();

  // Yahoo identifiers are only mandatory when Yahoo is the active provider.
  const leagueId = provider === "yahoo" ? required("YAHOO_LEAGUE_ID") : process.env.YAHOO_LEAGUE_ID?.trim() ?? "";
  const teamId = provider === "yahoo" ? required("YAHOO_TEAM_ID") : process.env.YAHOO_TEAM_ID?.trim() ?? "";
  const baseUrl = (process.env.YAHOO_BASE_URL?.trim() || "https://football.fantasysports.yahoo.com").replace(/\/$/, "");
  const headless = process.env.HEADLESS !== "false";
  const storageStatePath = resolve(
    projectRoot,
    process.env.STORAGE_STATE_PATH?.trim() || ".auth/storageState.json",
  );
  const week = optionalInt("YAHOO_WEEK") ?? optionalInt("ESPN_WEEK");

  const teamUrl = `${baseUrl}/f1/${leagueId}/${teamId}`;
  const lineupUrl = week
    ? `${baseUrl}/f1/${leagueId}/${teamId}/team?week=${week}`
    : `${baseUrl}/f1/${leagueId}/${teamId}/team`;

  const overrideThreshold = optionalInt("DRAFT_OVERRIDE_THRESHOLD") ?? 18;

  return {
    provider,
    leagueId,
    teamId,
    baseUrl,
    headless,
    storageStatePath,
    week,
    projectRoot,
    outputDir: resolve(projectRoot, "output"),
    teamUrl,
    lineupUrl,
    leagueSettingsUrl: `${baseUrl}/f1/${leagueId}/settings`,
    preRankUrl: `${baseUrl}/f1/${leagueId}/${teamId}/editprerank`,
    overrideThreshold,
    espn: provider === "espn" ? loadEspnConfig() : undefined,
  };
}
