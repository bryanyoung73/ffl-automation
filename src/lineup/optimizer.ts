import {
  DEFAULT_UNSTARTABLE,
  type Assignment,
  type LineupChange,
  type LineupDiff,
  type LineupPlan,
  type Player,
  type PlayerStatus,
  type StartingSlot,
} from "./types.js";

export interface OptimizeOptions {
  /** Statuses that bar a player from starting. Defaults to DEFAULT_UNSTARTABLE. */
  unstartableStatuses?: readonly PlayerStatus[];
  /**
   * Players (by id) the user has pinned. Pinned players are forced into their
   * currentSlot if that slot is a starting slot; the optimizer fills the rest.
   */
  pinnedPlayerIds?: readonly string[];
}

/**
 * Expand a flat list of slot codes into indexed StartingSlot objects.
 * e.g. ["RB","RB","WR"] -> [{RB,0},{RB,1},{WR,0}]
 */
export function expandSlots(slotCodes: readonly string[]): StartingSlot[] {
  const seen = new Map<string, number>();
  return slotCodes.map((code) => {
    const index = seen.get(code) ?? 0;
    seen.set(code, index + 1);
    return { code, index };
  });
}

function canFill(player: Player, slotCode: string): boolean {
  return player.position === slotCode || player.eligibleSlots.includes(slotCode);
}

function slotKey(slot: StartingSlot): string {
  return `${slot.code}#${slot.index}`;
}

/**
 * Compute the highest-projected legal starting lineup.
 *
 * Branch-and-bound over slots: at each slot try every eligible unused player
 * (and "leave empty"), pruning branches that cannot beat the best full lineup
 * found so far. Rosters are tiny (~15 players / ~10 slots) so this is instant
 * and always returns the true optimum. Ties break by lower player name then id,
 * so results are deterministic.
 */
export function optimizeLineup(
  players: readonly Player[],
  startingSlotCodes: readonly string[],
  options: OptimizeOptions = {},
): LineupPlan {
  const unstartable = new Set(options.unstartableStatuses ?? DEFAULT_UNSTARTABLE);
  const pinned = new Set(options.pinnedPlayerIds ?? []);
  const slots = expandSlots(startingSlotCodes);

  // Pinning is an explicit override — most commonly a player whose game has
  // already started (locked) and whose slot literally cannot change, whatever
  // his medical status says. So a pinned player is in the pool even if his
  // status would otherwise bar him from starting (e.g. he got hurt mid-game
  // and is now "IR" but is still locked into the WR slot he kicked off in).
  const startable = [...players]
    .filter((p) => pinned.has(p.id) || !unstartable.has(p.status))
    .sort((a, b) =>
      b.projectedPoints - a.projectedPoints ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
    );

  // Force-pin: if a pinned player currently starts in one of our slots, lock it.
  const forced = new Map<number, number>(); // slotIdx -> player index
  const forcedPlayers = new Set<number>();
  slots.forEach((slot, slotIdx) => {
    const i = startable.findIndex(
      (p) => pinned.has(p.id) && p.currentSlot === slot.code,
    );
    if (i >= 0 && !forcedPlayers.has(i)) {
      forced.set(slotIdx, i);
      forcedPlayers.add(i);
    }
  });

  // Candidate player indices per slot, best projection first. A pinned player
  // is only ever a candidate for his forced slot — never poached into a
  // different one — and a pinned player with no forced slot (e.g. pinned
  // while sitting on the bench) is not a candidate anywhere: he's frozen off
  // the field, not merely exempted from the status filter.
  const candidates: number[][] = slots.map((slot, slotIdx) =>
    startable.map((_, i) => i).filter((i) => {
      if (pinned.has(startable[i]!.id)) return forced.get(slotIdx) === i;
      return canFill(startable[i]!, slot.code);
    }),
  );

  // Optimistic remaining value: for each not-yet-filled slot, the best
  // projection among still-available candidates (ignores collisions -> upper bound).
  function bound(slotIdx: number, used: boolean[]): number {
    let total = 0;
    for (let s = slotIdx; s < slots.length; s++) {
      for (const i of candidates[s]!) {
        if (!used[i]) {
          total += startable[i]!.projectedPoints;
          break;
        }
      }
    }
    return total;
  }

  let bestScore = -Infinity;
  let bestPick: (number | null)[] = slots.map(() => null);

  const used: boolean[] = startable.map(() => false);
  const pick: (number | null)[] = [];

  function dfs(slotIdx: number, score: number): void {
    if (slotIdx === slots.length) {
      if (score > bestScore) {
        bestScore = score;
        bestPick = [...pick];
      }
      return;
    }
    if (score + bound(slotIdx, used) <= bestScore) return;

    const force = forced.get(slotIdx);
    const options_ = force !== undefined ? [force] : candidates[slotIdx]!;

    for (const i of options_) {
      if (used[i]) continue;
      used[i] = true;
      pick.push(i);
      dfs(slotIdx + 1, score + startable[i]!.projectedPoints);
      pick.pop();
      used[i] = false;
    }

    // Leave the slot empty (only matters when the roster is short-handed).
    if (force === undefined) {
      pick.push(null);
      dfs(slotIdx + 1, score);
      pick.pop();
    }
  }

  dfs(0, 0);

  const chosen = new Set<string>();
  const assignments: Assignment[] = slots.map((slot, slotIdx) => {
    const i = bestPick[slotIdx];
    const player = i === null || i === undefined ? null : startable[i]!;
    if (player) chosen.add(player.id);
    return { slot, player };
  });

  const bench = [...players]
    .filter((p) => !chosen.has(p.id))
    .sort((a, b) =>
      b.projectedPoints - a.projectedPoints || a.name.localeCompare(b.name),
    );

  const totalProjected = round1(
    assignments.reduce((sum, a) => sum + (a.player?.projectedPoints ?? 0), 0),
  );

  return { assignments, bench, totalProjected };
}

/**
 * Diff the current roster slots against a plan: the minimal set of slot moves
 * needed, plus the projected-points swing.
 */
export function diffLineup(players: readonly Player[], plan: LineupPlan): LineupDiff {
  const targetSlotById = new Map<string, string>();
  for (const a of plan.assignments) {
    if (a.player) targetSlotById.set(a.player.id, slotLabel(a.slot));
  }

  const changes: LineupChange[] = [];
  for (const player of players) {
    const to = targetSlotById.get(player.id) ?? "BN";
    const from = normalizeSlot(player.currentSlot);
    if (baseSlot(to) !== baseSlot(from)) {
      changes.push({ player, fromSlot: from, toSlot: to });
    }
  }

  const startingIds = new Set(targetSlotById.keys());
  const currentStarters = players.filter((p) => isStartingSlot(p.currentSlot));
  // A submission is only worthwhile when the *set* of starters changes. Pure
  // slot-label reshuffles among the same starters (WR <-> W/R/T) score the same.
  const currentStartingIds = new Set(currentStarters.map((p) => p.id));
  const needsSubmit =
    currentStartingIds.size !== startingIds.size ||
    [...startingIds].some((id) => !currentStartingIds.has(id));
  const currentProjected = round1(
    currentStarters.reduce((s, p) => s + p.projectedPoints, 0),
  );
  const proposedProjected = round1(
    players
      .filter((p) => startingIds.has(p.id))
      .reduce((s, p) => s + p.projectedPoints, 0),
  );

  return {
    changes,
    needsSubmit,
    currentProjected,
    proposedProjected,
    delta: round1(proposedProjected - currentProjected),
  };
}

export function slotLabel(slot: StartingSlot): string {
  return slot.code;
}

function normalizeSlot(slot: string): string {
  const s = slot.trim().toUpperCase();
  if (s === "" || s === "BENCH") return "BN";
  return s;
}

function baseSlot(slot: string): string {
  return normalizeSlot(slot).replace(/#\d+$/, "");
}

function isStartingSlot(slot: string): boolean {
  const s = normalizeSlot(slot);
  return s !== "BN" && s !== "IR";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export { slotKey };
