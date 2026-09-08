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

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 200);
      if (res.status === 404) {
        throw new Error(
          `Sleeper GET ${path} -> 404. Check SLEEPER_LEAGUE_ID / SLEEPER_USERNAME ` +
            `in .env.\n${snippet}`,
        );
      }
      throw new Error(`Sleeper GET ${path} -> ${res.status}.\n${snippet}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Sleeper GET ${path}: response was not JSON.\n${text.slice(0, 200)}`);
    }
  }
}
