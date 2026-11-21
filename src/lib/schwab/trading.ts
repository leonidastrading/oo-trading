// Order client for the Stock Trades tab — the only code in the app that can send, change or cancel an order.
// Every call goes through: (1) the server-side guardrails in lib/stocks (callers), (2) this path allowlist
// (equity orders on the one trading account only), and (3) the STOCK_LIVE_TRADING=on server switch.
// Without the switch nothing is sent; dry-run mode never reaches this file.
import "server-only";
import { SCHWAB_API } from "./readonly";
import { SchwabApiError, takeRateToken } from "./client";
import { assertEquityOnly, isAllowedOrderPath } from "./orderGuard";
import { getAccessToken } from "./tokens";

/** The server-side switch for live orders (a Vercel env var; off unless set to "on"). */
export function liveTradingEnabled(): boolean {
  return process.env.STOCK_LIVE_TRADING === "on";
}

/** Send an order request; returns the parsed JSON (GET) or the order id from the Location header (POST/PUT). */
export async function schwabOrder<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ orderId: string | null; data: T | null }> {
  if (!isAllowedOrderPath(method, path)) throw new Error(`Blocked order request: ${method} ${path}`);
  if (method !== "GET" && !liveTradingEnabled()) throw new Error("Live trading is switched off on the server (STOCK_LIVE_TRADING)");
  if (body !== undefined) assertEquityOnly(body);
  let refreshed = false;
  for (;;) {
    await takeRateToken();
    const token = await getAccessToken(refreshed);
    const res = await fetch(SCHWAB_API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if (!res.ok) throw new SchwabApiError(`Schwab ${res.status}: ${(await res.text()).slice(0, 300) || res.statusText}`, res.status);
    const loc = res.headers.get("location");
    const orderId = loc?.match(/\/orders\/(\d+)/)?.[1] ?? null;
    const text = await res.text();
    return { orderId, data: text ? (JSON.parse(text) as T) : null };
  }
}
