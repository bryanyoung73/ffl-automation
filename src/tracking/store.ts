import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.js";

/**
 * Recommendation-tracking storage — an append-only per-season log of every
 * lineup the optimizer recommended, kept for later grading against what
 * actually got played (src/tracking/grade.ts, phase 2).
 *
 * Deliberately NOT under `.cache/` — this is real season history the user
 * cares about, not disposable derived data a "clear the cache" instinct
 * should ever be able to wipe. See docs/specs/2026-09-21-recommendation-tracking.md.
 */

export interface SnapshotAssignment {
  slotCode: string;
  playerId: string;
  playerName: string;
}

export interface Snapshot {
  week: number;
  /** ISO time this recommendation was computed/shown. */
  fetchedAt: string;
  assignments: SnapshotAssignment[];
}

export function trackingDataDir(config: Config): string {
  return resolve(config.projectRoot, "data", "tracking");
}

function seasonFile(dataDir: string, season: number): string {
  return resolve(dataDir, `${season}.json`);
}

/** All snapshots recorded for a season, oldest first. Empty if none yet. */
export function readSnapshots(dataDir: string, season: number): Snapshot[] {
  const file = seasonFile(dataDir, season);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as Snapshot[]) : [];
  } catch {
    return [];
  }
}

/** Append one snapshot to the season's log. */
export function appendSnapshot(dataDir: string, season: number, snapshot: Snapshot): void {
  mkdirSync(dataDir, { recursive: true });
  const existing = readSnapshots(dataDir, season);
  existing.push(snapshot);
  writeFileSync(seasonFile(dataDir, season), JSON.stringify(existing, null, 2), "utf8");
}
