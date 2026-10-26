"use client";

import { signOut } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ChangePassword } from "@/components/ChangePassword";
import { Banner } from "@/components/StatusBar";
import { UploadTrades } from "@/components/UploadTrades";
import type { TokenStatus } from "@/lib/schwab/tokens";
import { formatDateTimeET, formatTimeET } from "@/lib/time";

interface Status {
  now: number;
  setupError?: string;
  token: TokenStatus;
  accountLast4: string | null;
  configured: { clientId: boolean; clientSecret: boolean; redirectUri: string | null };
  rate: { usedThisMinute: number; limit: number };
  backoffUntil: number | null;
  accountFetchedAt: number | null;
}


function SettingsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const loadStatus = useCallback(() => {
    fetch("/api/schwab/status", { cache: "no-store" })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setMsg({ tone: "error", text: "Could not load Schwab status" }));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const schwabParam = params.get("schwab");

  async function reset(what: "trades" | "snapshots" | "schwab", label: string) {
    const typed = window.prompt(`This permanently deletes ${label}. Type RESET to confirm.`);
    if (typed !== "RESET") return;
    const res = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what, confirm: "RESET" }),
    });
    setMsg(res.ok ? { tone: "info", text: `Deleted ${label}.` } : { tone: "error", text: `Reset failed (${res.status})` });
    loadStatus();
  }

  async function snapshotNow() {
    setBusy(true);
    const res = await fetch("/api/snapshots", { method: "POST" });
    const j = await res.json();
    setMsg(res.ok ? { tone: "info", text: `Saved snapshot for ${j.date}.` } : { tone: "error", text: j.error ?? "Snapshot failed" });
    setBusy(false);
  }

  const t = status?.token;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Settings</h1>
        <span className="num text-sm text-ink-2">Last updated {formatTimeET(status?.now)}</span>
      </div>

      {status?.setupError && <Banner tone="error">{status.setupError}</Banner>}
      {schwabParam === "connected" && <Banner tone="info">✓ Schwab connected.</Banner>}
      {schwabParam === "error" && <Banner tone="error">Schwab connection failed ({params.get("reason") ?? "unknown"}). Try again.</Banner>}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <section className="card space-y-4 p-4">
        <h2 className="text-lg font-bold text-accent">Schwab connection</h2>
        {t?.warn && (
          <Banner tone="warn">
            {t.needsReconnect
              ? "Not connected or login expired — reconnect to resume live data."
              : `Refresh token expires in ${t.refreshDaysLeft} days — reconnect soon (Schwab requires a browser login every 7 days).`}
          </Banner>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Status</dt>
          <dd className={t?.connected ? "text-gain" : "text-loss"}>{t ? (t.connected ? "✓ Connected" : "✕ Not connected") : "…"}</dd>
          <dt className="text-muted">Account</dt>
          <dd>••{status?.accountLast4 ?? "????"}</dd>
          <dt className="text-muted">Logged in</dt>
          <dd>{formatDateTimeET(t?.connectedAt)}</dd>
          <dt className="text-muted">Refresh token</dt>
          <dd>
            {t?.refreshExpiresAt ? (
              <>
                expires {formatDateTimeET(t.refreshExpiresAt)}{" "}
                <span className={t.warn ? "text-warn" : "text-ink-2"}>({t.refreshDaysLeft} days left)</span>
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-muted">Access token</dt>
          <dd>{t?.accessExpiresAt ? `expires ${formatTimeET(t.accessExpiresAt)} (auto-refreshed)` : "—"}</dd>
          <dt className="text-muted">API usage</dt>
          <dd>
            {status ? `${status.rate.usedThisMinute}/${status.rate.limit} requests this minute` : "—"}
            {status?.backoffUntil ? <span className="text-warn"> · backing off until {formatTimeET(status.backoffUntil)}</span> : null}
          </dd>
          <dt className="text-muted">Last account fetch</dt>
          <dd>{formatTimeET(status?.accountFetchedAt)}</dd>
          {t?.lastError && (
            <>
              <dt className="text-muted">Last error</dt>
              <dd className="text-loss">{t.lastError}</dd>
            </>
          )}
          <dt className="text-muted">Config</dt>
          <dd className="break-all text-ink-2">
            client id {status?.configured.clientId ? "✓" : "✕"} · secret {status?.configured.clientSecret ? "✓" : "✕"} · callback{" "}
            {status?.configured.redirectUri ?? "✕ missing"}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <a href="/api/schwab/authorize" className="rounded-lg bg-accent px-4 py-2 font-semibold text-black">
            {t?.connected ? "Reconnect Schwab" : "Connect Schwab"}
          </a>
          <button onClick={snapshotNow} disabled={busy || !t?.connected} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">
            Save EOD snapshot now
          </button>
        </div>
        <p className="text-xs text-muted">Read-only: this dashboard only reads accounts, positions, balances, quotes and transactions. It cannot place orders.</p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold text-accent">Upload Option Omega trade logs</h2>
        <p className="text-sm text-ink-2">
          CSV exports from OO&apos;s trade log. Duplicates (same strategy + date/time opened + legs) are skipped, so re-uploading is safe.
          If a file has no Strategy column, the file name is used.
        </p>
        <UploadTrades />
      </section>

      <ChangePassword />

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold text-accent">Data reset</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => reset("trades", "all uploaded OO trades")} className="rounded-lg border border-loss/50 px-4 py-2 text-loss">
            Delete OO trades
          </button>
          <button onClick={() => reset("snapshots", "all EOD snapshots")} className="rounded-lg border border-loss/50 px-4 py-2 text-loss">
            Delete snapshots
          </button>
          <button onClick={() => reset("schwab", "the stored Schwab tokens")} className="rounded-lg border border-loss/50 px-4 py-2 text-loss">
            Disconnect Schwab
          </button>
        </div>
      </section>

      <section className="text-sm">
        <button onClick={() => signOut({ callbackUrl: "/login" })} className="text-link underline">
          Sign out
        </button>
      </section>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
