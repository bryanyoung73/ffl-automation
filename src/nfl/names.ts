/**
 * Pure name/team normalization shared by every cross-source player join
 * (Sleeper identity, FantasyPros ECR, ...). No I/O.
 */

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** lowercase, drop punctuation and generational suffixes, collapse spaces. */
export function normalizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/['’`.]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(" ")
    .filter((p) => !SUFFIXES.has(p))
    .join(" ");
}

const TEAM_ALIASES: Record<string, string> = {
  JAC: "JAX",
  WAS: "WSH",
  WFT: "WSH",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
  ARZ: "ARI",
};

/** Canonical NFL team code, folding the known provider spellings together. */
export function teamCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const up = raw.toUpperCase().trim();
  return TEAM_ALIASES[up] ?? up;
}
