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
 * Per-instance memory in front of KV: a warm function instance answers repeat reads from memory instead of
 * reading and parsing the KV copy each time (most of the CPU on a busy page). A memory copy is trusted for at
 * most MEM_TRUST_MS since it was last read from or written to KV, so other instances' refreshes still show
 * up within that time, and never beyond the caller's maxAge.
 */
const MEM_TRUST_MS = 15_000;
const memory = new Map<string, { entry: Entry<unknown>; at: number }>();
const remember = <T>(key: string, entry: Entry<T> | null) => {
  if (entry) memory.set(key, { entry, at: Date.now() });
};

/**
 * Return cached data if younger than maxAgeMs, otherwise refresh with a cross-instance
 * lock. On failure, the last good data is returned along with the error.
 */
export async function cached<T>(
  name: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
  opts: { force?: boolean; keepSeconds?: number } = {},
): Promise<CacheResult<T>> {
  const keep = opts.keepSeconds ?? KEEP_SECONDS;
  const store = kv();
  const key = KEYS.cache(name);
  const mem = memory.get(key);
  if (mem && !opts.force && Date.now() - mem.at < MEM_TRUST_MS && Date.now() - mem.entry.fetchedAt < maxAgeMs) {
    const e = mem.entry as Entry<T>;
    const err = e.lastErrorAt && e.lastErrorAt > e.fetchedAt ? e.lastError ?? null : null;
    return { data: e.data, fetchedAt: e.fetchedAt, error: err };
  }
  const entry = await store.get<Entry<T>>(key);
  remember(key, entry);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  const recentError = entry?.lastErrorAt && entry.lastErrorAt > entry.fetchedAt ? entry.lastError ?? null : null;
  if (entry && !opts.force && age < maxAgeMs) {
    return { data: entry.data, fetchedAt: entry.fetchedAt, error: recentError };
  }

  const locked = await store.set(KEYS.lock(name), 1, { px: 12_000, nx: true });
  if (!locked) {
    // Someone else is fetching (e.g. several panels loading at once when a phone wakes): wait for their
    // result rather than hand back a stale copy that would show as "Data delayed".
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const e = await store.get<Entry<T>>(key);
      if (e && (!entry || e.fetchedAt > entry.fetchedAt)) {
        remember(key, e);
        return { data: e.data, fetchedAt: e.fetchedAt, error: null };
      }
    }
    if (entry) return { data: entry.data, fetchedAt: entry.fetchedAt, error: recentError };
    return { data: null, fetchedAt: null, error: "Timed out waiting for data" };
  }

  try {
    const data = await fetcher();
    const next: Entry<T> = { data, fetchedAt: Date.now(), lastError: null, lastErrorAt: null };
    await store.set(key, next, { ex: keep });
    remember(key, next);
    return { data, fetchedAt: next.fetchedAt, error: null };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`[cache:${name}]`, msg);
    if (entry) await store.set(key, { ...entry, lastError: msg, lastErrorAt: Date.now() }, { ex: keep });
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
