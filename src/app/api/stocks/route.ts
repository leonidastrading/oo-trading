import { NextResponse } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { kv } from "@/lib/kv";
import { liveTradingEnabled } from "@/lib/schwab/trading";
import { accountValue, unmanagedStocks, type HeldStock, killSwitchOn, loadAlerts, loadLog, loadSettings, loadTrades, reconcile, stockQuotes, tradingAccount, type LogEntry } from "@/lib/stocks/engine";
import { cached } from "@/lib/cache";
import { effectiveSettings, extendedSession, regularSession, shadowExposure, sizeUpStage, streakLockUntil, summarize, weekShadowPl, type StoredSettings, type Summary, type Trade } from "@/lib/stocks/rules";

export const dynamic = "force-dynamic";

export interface StocksData {
  meta: { pollMs: number | null; errors: string[] };
  account: { last4: string; nickname: string | null; type: string | null } | null;
  mode: "dry" | "live";
  liveSwitch: boolean;
  settings: ReturnType<typeof effectiveSettings>;
  pending: StoredSettings["pending"];
  kill: boolean;
  trades: Trade[];
  quotes: Record<string, number | null>;
  log: LogEntry[];
  alerts: { id: string; at: number; text: string }[];
  summary: Summary;
  blocks: LogEntry[];
  sizeUp: string | null;
  /** Stock positions at Schwab the tab isn't managing (to adopt). */
  unmanaged: HeldStock[];
  overrides: number;
  accountValue: number | null;
  /** Server time of this snapshot (ms). */
  now: number;
  exposure: { long: number; short: number; gross: number; net: number; grossPct: number | null; netPct: number | null };
  lockouts: { weekShadowPl: number; streakUntil: string | null };
}

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const errors: string[] = [];
  // Light sync while the market is open (at most once a minute across all viewers); the cron does the rest.
  if (extendedSession() && (await kv().set("stocks:recon-throttle", 1, { px: 60_000, nx: true }))) {
    await reconcile().catch((e: Error) => errors.push(`Sync: ${e.message}`));
  }
  const [stored, trades, kill, log, alerts] = await Promise.all([loadSettings(), loadTrades(), killSwitchOn(), loadLog(), loadAlerts()]);
  const settings = effectiveSettings(stored);
  const mode = settings.dryRun ? "dry" : "live";
  const acct = await tradingAccount().catch((e: Error) => {
    errors.push(`Account: ${e.message}`);
    return null;
  });
  const account = acct ? { last4: acct.last4, nickname: acct.nickname, type: acct.type } : null;
  // Account value for % figures: refreshed at most every 15 minutes here (orders read it fresh).
  const acctValue = acct ? ((await cached("stocks:account-value", 15 * 60_000, () => accountValue(acct)).catch(() => null))?.data ?? null) : null;
  const open = trades.filter((t) => ["pending", "open", "closing"].includes(t.status));
  // SPY and each open trade's benchmark ETF too, for the market-relative (excess) figures.
  const q = await stockQuotes(open.length ? [...open.map((t) => t.ticker), "SPY", ...open.flatMap((t) => (t.benchmark ? [t.benchmark] : []))] : []).catch(() => ({}));
  const summary = summarize(trades, mode);
  summary.shadowPlPct = acctValue ? Math.round((summary.shadowPl / acctValue) * 10000) / 100 : null;
  const ex = shadowExposure(trades, mode);
  // Overrides only come from adopted trades that broke a guardrail; any of them stops the size-up banner.
  const overrides = trades.filter((t) => t.mode === mode && (t.overrides?.length ?? 0) > 0).length;
  const unmanaged = acct ? await unmanagedStocks(acct, trades).catch((e: Error) => (errors.push(`Positions: ${e.message}`), [] as HeldStock[])) : [];
  const body: StocksData = {
    meta: { pollMs: regularSession() ? 60_000 : extendedSession() ? 5 * 60_000 : null, errors },
    account,
    mode,
    liveSwitch: liveTradingEnabled(),
    settings,
    pending: (stored?.pending ?? []).filter((p) => p.effectiveAt > Date.now()),
    kill,
    trades,
    quotes: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.last])),
    log,
    alerts,
    summary,
    blocks: log.filter((l) => l.kind === "block"),
    sizeUp: sizeUpStage(trades, mode, overrides).label,
    unmanaged,
    overrides,
    accountValue: acctValue,
    now: Date.now(),
    exposure: { ...ex, grossPct: acctValue ? (ex.gross / acctValue) * 100 : null, netPct: acctValue ? (ex.net / acctValue) * 100 : null },
    lockouts: { weekShadowPl: weekShadowPl(trades, mode, Date.now()), streakUntil: streakLockUntil(trades, mode) },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
