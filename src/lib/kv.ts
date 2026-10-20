// Tiny KV abstraction: Upstash Redis (Vercel KV / Marketplace) in production,
// in-memory fallback for local development and tests.
import "server-only";
import { Redis } from "@upstash/redis";

export interface SetOpts {
  ex?: number; // seconds
  px?: number; // ms
  nx?: boolean;
}

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: SetOpts): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  incr(key: string, expireSeconds: number): Promise<number>;
  hgetall<T>(key: string): Promise<Record<string, T>>;
  hset(key: string, field: string, value: unknown): Promise<void>;
  /** Set fields only if absent; returns how many were added. */
  hsetnxMany(key: string, entries: [string, unknown][]): Promise<number>;
  hlen(key: string): Promise<number>;
}

class RedisStore implements Store {
  constructor(private r: Redis) {}
  async get<T>(key: string) {
    return (await this.r.get<T>(key)) ?? null;
  }
  async set(key: string, value: unknown, opts: SetOpts = {}) {
    const o: Record<string, unknown> = {};
    if (opts.ex) o.ex = opts.ex;
    if (opts.px) o.px = opts.px;
    if (opts.nx) o.nx = true;
    const res = await this.r.set(key, value, o as never);
    return res === "OK";
  }
  async del(...keys: string[]) {
    if (keys.length) await this.r.del(...keys);
  }
  async incr(key: string, expireSeconds: number) {
    const p = this.r.pipeline();
    p.incr(key);
    p.expire(key, expireSeconds);
    const [n] = await p.exec<[number, number]>();
    return n;
  }
  async hgetall<T>(key: string) {
    return ((await this.r.hgetall<Record<string, T>>(key)) ?? {}) as Record<string, T>;
  }
  async hset(key: string, field: string, value: unknown) {
    await this.r.hset(key, { [field]: value });
  }
  async hsetnxMany(key: string, entries: [string, unknown][]) {
    let added = 0;
    for (let i = 0; i < entries.length; i += 500) {
      const p = this.r.pipeline();
      for (const [f, v] of entries.slice(i, i + 500)) p.hsetnx(key, f, v);
      const res = await p.exec<number[]>();
      added += res.filter((x) => x === 1).length;
    }
    return added;
  }
  async hlen(key: string) {
    return this.r.hlen(key);
  }
}

type Entry = { v: unknown; exp: number | null };

class MemoryStore implements Store {
  private m = new Map<string, Entry>();
  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (e && e.exp !== null && e.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  async get<T>(key: string) {
    return (this.live(key)?.v as T) ?? null;
  }
  async set(key: string, value: unknown, opts: SetOpts = {}) {
    if (opts.nx && this.live(key)) return false;
    const ttl = opts.px ?? (opts.ex ? opts.ex * 1000 : null);
    this.m.set(key, { v: structuredClone(value), exp: ttl ? Date.now() + ttl : null });
    return true;
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.m.delete(k));
  }
  async incr(key: string, expireSeconds: number) {
    const n = Number(this.live(key)?.v ?? 0) + 1;
    this.m.set(key, { v: n, exp: Date.now() + expireSeconds * 1000 });
    return n;
  }
  private hash(key: string): Record<string, unknown> {
    const e = this.live(key);
    if (e) return e.v as Record<string, unknown>;
    const h = {};
    this.m.set(key, { v: h, exp: null });
    return h;
  }
  async hgetall<T>(key: string) {
    return { ...(this.hash(key) as Record<string, T>) };
  }
  async hset(key: string, field: string, value: unknown) {
    this.hash(key)[field] = structuredClone(value);
  }
  async hsetnxMany(key: string, entries: [string, unknown][]) {
    const h = this.hash(key);
    let added = 0;
    for (const [f, v] of entries) {
      if (!(f in h)) {
        h[f] = structuredClone(v);
        added++;
      }
    }
    return added;
  }
  async hlen(key: string) {
    return Object.keys(this.hash(key)).length;
  }
}

const g = globalThis as unknown as { __kv?: Store };

export function kv(): Store {
  if (g.__kv) return g.__kv;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    g.__kv = new RedisStore(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL) throw new Error("KV is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN");
    console.warn("[kv] No Redis configured; using in-memory store (dev only).");
    g.__kv = new MemoryStore();
  }
  return g.__kv;
}

export const KEYS = {
  tokens: "schwab:tokens",
  oauthState: (s: string) => `schwab:oauth-state:${s}`,
  accountHash: "schwab:account-hash",
  refreshLock: "schwab:refresh-lock",
  rateWindow: (minute: number) => `schwab:rl:${minute}`,
  backoff: "schwab:backoff",
  cache: (name: string) => `cache:${name}`,
  lock: (name: string) => `lock:${name}`,
  manual: (name: string) => `manual:${name}`,
  ooTrades: "oo:trades",
  ooMeta: "oo:meta",
  eod: "eod:snapshots",
} as const;
