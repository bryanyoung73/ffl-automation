import type { SignalProvider, SignalProviderContext } from "./types.js";

/**
 * Expert Consensus Ranking from FantasyPros. Not yet implemented — scraping a
 * third-party site is a fast-follow (see docs/specs/2026-08-28-draft-prep-design.md).
 *
 * When built, it should fetch the ECR list for the league's scoring format,
 * fuzzy-match names to Yahoo player ids, and return {id -> ecrRank}.
 */
export const fantasyProsProvider: SignalProvider = {
  name: "ecr",
  async ranks(_ctx: SignalProviderContext): Promise<Map<string, number>> {
    throw new Error(
      "FantasyPros ECR provider is not implemented yet. Run without --with-ecr.",
    );
  },
};
