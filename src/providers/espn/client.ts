import type { EspnConfig } from "../../config.js";

/**
 * Minimal fetch wrapper for ESPN's (unofficial) Fantasy v3 API.
 *
 * Reads go to lm-api-reads, writes to lm-api-writes. Private leagues need the
 * `espn_s2` + `SWID` cookies from a logged-in browser session.
 */
export class EspnClient {
  /** Per-process GET memo — league data doesn't change during a CLI run, and
   *  several commands fetch `mSettings` more than once. */
  private readonly getCache = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: EspnConfig) {}

  private cookieHeader(): string {
    return `espn_s2=${this.cfg.s2}; SWID=${this.cfg.swid}`;
  }

  /**
   * GET the league resource with one or more `?view=` params. Pass `filter` to
   * send an `x-fantasy-filter` header (already JSON-stringified by the caller).
   * Extra query params (e.g. `forTeamId`, `scoringPeriodId`) go in `params`.
   * Identical requests within one process are served from an in-memory memo;
   * pass `noCache` for endpoints that change during a run (the live draft).
   */
  async get<T = unknown>(
    views: string[],
    opts: {
      filter?: string;
      params?: Record<string, string | number>;
      noCache?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.cfg.readBaseUrl);
    for (const v of views) url.searchParams.append("view", v);
    for (const [k, val] of Object.entries(opts.params ?? {})) {
      url.searchParams.append(k, String(val));
    }

    const key = `${url.href}\n${opts.filter ?? ""}`;
    if (!opts.noCache) {
      const cached = this.getCache.get(key);
      if (cached) return cached as Promise<T>;
    }

    const headers: Record<string, string> = {
      Cookie: this.cookieHeader(),
      Accept: "application/json",
    };
    if (opts.filter) headers["x-fantasy-filter"] = opts.filter;

    const p = fetch(url, { headers }).then((res) =>
      this.parse<T>(res, `GET ${url.pathname}${url.search}`),
    );
    if (!opts.noCache) {
      this.getCache.set(key, p);
      p.catch(() => this.getCache.delete(key)); // don't cache a rejection
    }
    return p;
  }

  /** POST to a path relative to the write base, e.g. "transactions/". */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.cfg.writeBaseUrl}/${path.replace(/^\//, "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res, `POST ${path}`);
  }

  private async parse<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `ESPN ${what} -> ${res.status}. Check ESPN_S2 / ESPN_SWID in .env ` +
            `(copy fresh from a logged-in browser), or the league may not be ` +
            `visible to that account.\n${snippet}`,
        );
      }
      throw new Error(`ESPN ${what} -> ${res.status}.\n${snippet}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ESPN ${what}: response was not JSON.\n${text.slice(0, 300)}`);
    }
  }
}
