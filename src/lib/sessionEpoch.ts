// Sessions issued before the last password change are rejected (used by proxy.ts).
// Talks to Redis directly so it stays importable from the proxy.
import { Redis } from "@upstash/redis";

export const SESSIONS_VALID_AFTER_KEY = "auth:sessions-valid-after";

let redis: Redis | null | undefined;

function client(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

/** Epoch ms; sessions authenticated before this are invalid. 0 if never set or no Redis. */
export async function sessionsValidAfter(): Promise<number> {
  try {
    return Number((await client()?.get<number>(SESSIONS_VALID_AFTER_KEY)) ?? 0);
  } catch {
    return 0;
  }
}
