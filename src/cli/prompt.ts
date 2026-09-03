import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** The token after `--name` on argv, or undefined if the flag is absent. */
export function strFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

/** `strFlag` parsed as a base-10 int; undefined if absent or unparseable. */
export function intFlag(name: string): number | undefined {
  const raw = strFlag(name);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}
