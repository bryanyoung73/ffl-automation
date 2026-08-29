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
