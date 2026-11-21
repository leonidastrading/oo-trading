import { NextResponse } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { kv } from "@/lib/kv";
import { liveTradingEnabled } from "@/lib/schwab/trading";
import { killSwitchOn, loadAlerts, loadLog, loadSettings, loadTrades, reconcile, stockQuotes, tradingAccount, type LogEntry } from "@/lib/stocks/engine";
import { effectiveSettings, regularSession, sizeUpEligible, streakLockUntil, summarize, weekShadowPl, type StoredSettings, type Summary, type Trade } from "@/lib/stocks/rules";

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
  sizeUp: boolean;
  lockouts: { weekShadowPl: number; streakUntil: string | null };
}

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const errors: string[] = [];
  // Light sync while the market is open (at most once a minute across all viewers); the cron does the rest.
  if (regularSession() && (await kv().set("stocks:recon-throttle", 1, { px: 60_000, nx: true }))) {
    await reconcile().catch((e: Error) => errors.push(`Sync: ${e.message}`));
  }
  const [stored, trades, kill, log, alerts] = await Promise.all([loadSettings(), loadTrades(), killSwitchOn(), loadLog(), loadAlerts()]);
  const settings = effectiveSettings(stored);
  const mode = settings.dryRun ? "dry" : "live";
  const account = await tradingAccount()
    .then((a) => ({ last4: a.last4, nickname: a.nickname, type: a.type }))
    .catch((e: Error) => {
      errors.push(`Account: ${e.message}`);
      return null;
    });
  const open = trades.filter((t) => ["pending", "open", "closing"].includes(t.status));
  const q = await stockQuotes(open.map((t) => t.ticker)).catch(() => ({}));
  const summary = summarize(trades, mode);
  const overrides = log.filter((l) => l.kind === "change" && /override/i.test(l.text)).length; // none exist: the rules can't be overridden
  const body: StocksData = {
    meta: { pollMs: regularSession() ? 60_000 : null, errors },
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
    sizeUp: sizeUpEligible(summary, overrides),
    lockouts: { weekShadowPl: weekShadowPl(trades, mode, Date.now()), streakUntil: streakLockUntil(trades, mode) },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
