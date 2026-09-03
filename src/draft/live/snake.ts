/**
 * Snake-draft turn math. Pure — a 1-based draft slot in, overall pick numbers
 * out. "completed" everywhere means the overall number of the last pick made
 * (equivalently, the count of picks made so far).
 */

/**
 * The overall pick numbers that belong to `slot` (1-based draft position) over
 * `rounds` rounds of a `teams`-team snake.
 */
export function mySlots(slot: number, teams: number, rounds: number): number[] {
  if (!Number.isInteger(slot) || slot < 1 || slot > teams) {
    throw new RangeError(`draft slot ${slot} out of range for a ${teams}-team league`);
  }
  const out: number[] = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1);
  }
  return out;
}

/**
 * Picks between now and my next one. `0` → I'm on the clock (my pick is the
 * very next one). `null` → I have no picks left.
 */
export function picksUntilNext(completed: number, mine: readonly number[]): number | null {
  const next = mine.find((m) => m > completed);
  return next === undefined ? null : next - completed - 1;
}

/** Picks between now and my *second* upcoming pick. `null` when fewer than two remain. */
export function picksUntilAfter(completed: number, mine: readonly number[]): number | null {
  const upcoming = mine.filter((m) => m > completed);
  return upcoming.length < 2 ? null : upcoming[1]! - completed - 1;
}

/** Overall pick number of my next pick, or `null` when I have none left. */
export function nextPick(completed: number, mine: readonly number[]): number | null {
  return mine.find((m) => m > completed) ?? null;
}
