// Read-only Schwab Trader API client with a global rate limiter and backoff.
import "server-only";
import { KEYS, kv } from "../kv";
import { assertReadOnly, SCHWAB_API } from "./readonly";
import { mockEnabled, mockResponse } from "./mock";
import { getAccessToken } from "./tokens";

export const RATE_LIMIT_PER_MIN = 60;
const MAX_BACKOFF_MS = 120_000;

export class SchwabApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAt?: number,
  ) {
    super(message);
  }
}

interface Backoff {
  n: number;
  until: number;
}

async function checkBackoff() {
  const b = await kv().get<Backoff>(KEYS.backoff);
  if (b && b.until > Date.now()) {
    throw new SchwabApiError(
      `Schwab is rate-limiting/erroring; retrying in ${Math.ceil((b.until - Date.now()) / 1000)}s`,
      429,
      b.until,
    );
  }
}

async function bumpBackoff(retryAfterSec?: number) {
  const prev = await kv().get<Backoff>(KEYS.backoff);
  const n = Math.min((prev?.n ?? 0) + 1, 10);
  const wait = retryAfterSec ? retryAfterSec * 1000 : Math.min(1000 * 2 ** n, MAX_BACKOFF_MS);
  const until = Date.now() + wait;
  await kv().set(KEYS.backoff, { n, until }, { px: wait + 10 * 60_000 });
  return until;
}

/** Global (all instances, all tabs) limiter: fixed one-minute windows in KV. */
async function takeRateToken() {
  const minute = Math.floor(Date.now() / 60_000);
  const n = await kv().incr(KEYS.rateWindow(minute), 70);
  if (n > RATE_LIMIT_PER_MIN) {
    throw new SchwabApiError("Local rate limit reached (60 requests/min); serving cached data", 429, (minute + 1) * 60_000);
  }
}

export async function rateUsage(): Promise<number> {
  return (await kv().get<number>(KEYS.rateWindow(Math.floor(Date.now() / 60_000)))) ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function schwabGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  assertReadOnly("GET", path);
  if (mockEnabled()) return mockResponse(path) as T;
  await checkBackoff();
  const url = new URL(SCHWAB_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    await takeRateToken();
    const token = await getAccessToken(refreshed);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      await bumpBackoff();
      throw new SchwabApiError(`Network error calling Schwab: ${(e as Error).message}`, 0);
    }

    if (res.ok) {
      await kv().del(KEYS.backoff);
      return (await res.json()) as T;
    }
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after")) || undefined;
      const until = await bumpBackoff(ra);
      throw new SchwabApiError(`Schwab ${res.status}: ${body || res.statusText}`, res.status, until);
    }
    throw new SchwabApiError(`Schwab ${res.status}: ${body || res.statusText}`, res.status);
  }
}

// ---- Endpoint wrappers (GET only) ----

export interface AccountNumber {
  accountNumber: string;
  hashValue: string;
}

export async function getAccountHash(): Promise<string> {
  const cached = await kv().get<string>(KEYS.accountHash);
  if (cached) return cached;
  const last4 = process.env.SCHWAB_ACCOUNT_LAST4;
  if (!last4) throw new SchwabApiError("Missing env var SCHWAB_ACCOUNT_LAST4", 0);
  const accounts = await schwabGet<AccountNumber[]>("/trader/v1/accounts/accountNumbers");
  const match = accounts.find((a) => a.accountNumber.endsWith(last4));
  if (!match) throw new SchwabApiError(`No Schwab account ending in ${last4}`, 404);
  await kv().set(KEYS.accountHash, match.hashValue, { ex: 24 * 3600 });
  return match.hashValue;
}
