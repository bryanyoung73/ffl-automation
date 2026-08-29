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

export interface Config {
  leagueId: string;
  teamId: string;
  baseUrl: string;
  headless: boolean;
  storageStatePath: string;
  week: number | undefined;
  projectRoot: string;
  /** Absolute URL of the team's home page. */
  teamUrl: string;
  /** Absolute URL of the editable lineup page (optionally week-pinned). */
  lineupUrl: string;
  /** Where CLI output and debug dumps go (gitignored). */
  outputDir: string;
  /** Draft-prep pages. */
  leagueSettingsUrl: string;
  preRankUrl: string;
  /** Default abs(rank) gap to flag a draft-board disagreement. */
  overrideThreshold: number;
}

export function loadConfig(): Config {
  const leagueId = required("YAHOO_LEAGUE_ID");
  const teamId = required("YAHOO_TEAM_ID");
  const baseUrl = (process.env.YAHOO_BASE_URL?.trim() || "https://football.fantasysports.yahoo.com").replace(/\/$/, "");
  const headless = process.env.HEADLESS !== "false";
  const storageStatePath = resolve(
    projectRoot,
    process.env.STORAGE_STATE_PATH?.trim() || ".auth/storageState.json",
  );
  const week = optionalInt("YAHOO_WEEK");

  const teamUrl = `${baseUrl}/f1/${leagueId}/${teamId}`;
  const lineupUrl = week
    ? `${baseUrl}/f1/${leagueId}/${teamId}/team?week=${week}`
    : `${baseUrl}/f1/${leagueId}/${teamId}/team`;

  const overrideThreshold = optionalInt("DRAFT_OVERRIDE_THRESHOLD") ?? 18;

  return {
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
  };
}
