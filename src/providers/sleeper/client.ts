import type { SleeperConfig } from "../../config.js";

/**
 * Minimal fetch wrapper for Sleeper's public read API (`api.sleeper.app/v1`).
 * No auth — reads need no token or cookies. Identical GETs within one process
 * are memoised; pass `noCache` for the live draft-picks poll.
 */
export class SleeperClient {
  private readonly getCache = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: SleeperConfig) {}

  async get<T>(path: string, opts: { noCache?: boolean } = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}/${path.replace(/^\//, "")}`;

    if (!opts.noCache) {
      const cached = this.getCache.get(url);
      if (cached) return cached as Promise<T>;
    }

    const p = fetch(url, { headers: { Accept: "application/json" } }).then((res) =>
      this.parse<T>(res, path),
    );
    if (!opts.noCache) {
      this.getCache.set(url, p);
      p.catch(() => this.getCache.delete(url));
    }
    return p;
  }

  /**
   * POST a GraphQL operation to Sleeper's authenticated endpoint (writes).
   * Needs `SLEEPER_TOKEN` — a bearer token from a logged-in sleeper.com session.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.cfg.token) {
      throw new Error(
        "SLEEPER_TOKEN is not set — required for writes. Copy it from a logged-in " +
          "sleeper.com session: DevTools → Application → Local Storage → `token`, " +
          "or the `authorization` header on any graphql request.",
      );
    }
    const res = await fetch("https://api.sleeper.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Sleeper graphql -> ${res.status}. SLEEPER_TOKEN is stale — grab a fresh one.`);
      }
      throw new Error(`Sleeper graphql -> ${res.status}.\n${text.slice(0, 300)}`);
    }
    let json: { data?: T; errors?: Array<{ message?: string }> };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Sleeper graphql: response was not JSON.\n${text.slice(0, 200)}`);
    }
    if (json.errors?.length) {
      throw new Error(`Sleeper graphql: ${json.errors.map((e) => e.message ?? "?").join("; ")}`);
    }
    if (json.data === undefined) throw new Error("Sleeper graphql: empty response.");
    return json.data;
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    // Sleeper's error bodies are unhelpful ("null", ""), so only surface a
    // snippet when it actually carries information.
    const snippet = text.trim();
    const detail = snippet && snippet !== "null" ? `\n${snippet.slice(0, 200)}` : "";

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(
          `Sleeper GET ${path} -> 404 (not found). The id may be wrong, from a ` +
            `different season, or a draft id rather than a league id. Check ` +
            `SLEEPER_LEAGUE_ID / SLEEPER_USERNAME in .env.${detail}`,
        );
      }
      throw new Error(`Sleeper GET ${path} -> ${res.status}.${detail}`);
    }
    if (snippet === "" || snippet === "null") {
      throw new Error(`Sleeper GET ${path}: empty response (id not found?).`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Sleeper GET ${path}: response was not JSON.${detail}`);
    }
  }
}
