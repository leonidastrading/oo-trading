// Shared KV cache so many tabs/devices never multiply Schwab calls.
import "server-only";
import { KEYS, kv } from "./kv";

interface Entry<T> {
  data: T;
  fetchedAt: number;
  lastError?: string | null;
  lastErrorAt?: number | null;
}

export interface CacheResult<T> {
  data: T | null;
  fetchedAt: number | null;
  error: string | null;
}

const KEEP_SECONDS = 14 * 24 * 3600;

/**
 * Return cached data if younger than maxAgeMs, otherwise refresh with a cross-instance
 * lock. On failure, the last good data is returned along with the error.
 */
export async function cached<T>(
  name: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
  opts: { force?: boolean } = {},
): Promise<CacheResult<T>> {
  const store = kv();
  const key = KEYS.cache(name);
  const entry = await store.get<Entry<T>>(key);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  const recentError = entry?.lastErrorAt && entry.lastErrorAt > entry.fetchedAt ? entry.lastError ?? null : null;
  if (entry && !opts.force && age < maxAgeMs) {
    return { data: entry.data, fetchedAt: entry.fetchedAt, error: recentError };
  }

  const locked = await store.set(KEYS.lock(name), 1, { px: 12_000, nx: true });
  if (!locked) {
    if (entry) return { data: entry.data, fetchedAt: entry.fetchedAt, error: recentError };
    // First load and someone else is fetching: wait for them.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const e = await store.get<Entry<T>>(key);
      if (e) return { data: e.data, fetchedAt: e.fetchedAt, error: null };
    }
    return { data: null, fetchedAt: null, error: "Timed out waiting for data" };
  }

  try {
    const data = await fetcher();
    const next: Entry<T> = { data, fetchedAt: Date.now(), lastError: null, lastErrorAt: null };
    await store.set(key, next, { ex: KEEP_SECONDS });
    return { data, fetchedAt: next.fetchedAt, error: null };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`[cache:${name}]`, msg);
    if (entry) await store.set(key, { ...entry, lastError: msg, lastErrorAt: Date.now() }, { ex: KEEP_SECONDS });
    return { data: entry?.data ?? null, fetchedAt: entry?.fetchedAt ?? null, error: msg };
  } finally {
    await store.del(KEYS.lock(name));
  }
}

export async function cacheAge(name: string): Promise<number | null> {
  const e = await kv().get<Entry<unknown>>(KEYS.cache(name));
  return e ? e.fetchedAt : null;
}

/** Manual refresh throttle: true if a manual refresh of `name` is allowed now. */
export async function takeManualRefresh(name: string, minIntervalMs: number): Promise<boolean> {
  return kv().set(KEYS.manual(name), Date.now(), { px: minIntervalMs, nx: true });
}
