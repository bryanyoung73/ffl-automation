import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface Envelope<T> {
  fetchedAt: string;
  data: T;
}

/** Read a cached JSON payload if it exists and is younger than `ttlMs`. */
export function readCache<T>(cacheDir: string, name: string, ttlMs: number): T | undefined {
  const file = resolve(cacheDir, name);
  if (!existsSync(file)) return undefined;
  const ageMs = Date.now() - statSync(file).mtimeMs;
  if (ageMs > ttlMs) return undefined;
  try {
    const env = JSON.parse(readFileSync(file, "utf8")) as Envelope<T>;
    return env.data;
  } catch {
    return undefined;
  }
}

export function writeCache<T>(cacheDir: string, name: string, data: T): void {
  mkdirSync(cacheDir, { recursive: true });
  const env: Envelope<T> = { fetchedAt: new Date().toISOString(), data };
  writeFileSync(resolve(cacheDir, name), JSON.stringify(env), "utf8");
}

/**
 * Fetch JSON, caching the parsed body to `<cacheDir>/<name>` for `ttlMs`.
 * `force` skips the read (but still writes). Returns `undefined` and leaves any
 * stale cache in place if the network call fails.
 */
export async function cachedJson<T>(
  cacheDir: string,
  name: string,
  url: string,
  opts: { ttlMs: number; force?: boolean; headers?: Record<string, string> },
): Promise<T | undefined> {
  if (!opts.force) {
    const hit = readCache<T>(cacheDir, name, opts.ttlMs);
    if (hit !== undefined) return hit;
  }
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...opts.headers } });
    if (!res.ok) return readCache<T>(cacheDir, name, Number.POSITIVE_INFINITY);
    const data = (await res.json()) as T;
    writeCache(cacheDir, name, data);
    return data;
  } catch {
    return readCache<T>(cacheDir, name, Number.POSITIVE_INFINITY);
  }
}
