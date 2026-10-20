"use client";

import { signOut } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/StatusBar";
import { parseOOTradeLog } from "@/lib/ooCsv";
import type { TokenStatus } from "@/lib/schwab/tokens";
import { formatDateTimeET, formatTimeET } from "@/lib/time";

interface Status {
  now: number;
  token: TokenStatus;
  accountLast4: string | null;
  configured: { clientId: boolean; clientSecret: boolean; redirectUri: string | null };
  rate: { usedThisMinute: number; limit: number };
  backoffUntil: number | null;
  accountFetchedAt: number | null;
}

interface FileResult {
  name: string;
  parsed: number;
  added: number;
  duplicates: number;
  errors: string[];
  done: boolean;
}

const CHUNK = 1000;

function SettingsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
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

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const out: FileResult[] = [];
    for (const file of Array.from(files)) {
      const r: FileResult = { name: file.name, parsed: 0, added: 0, duplicates: 0, errors: [], done: false };
      out.push(r);
      setResults([...out]);
      try {
        const { trades, errors, duplicatesInFile } = parseOOTradeLog(await file.text(), file.name.replace(/\.csv$/i, ""));
        r.parsed = trades.length;
        r.duplicates = duplicatesInFile;
        r.errors = errors;
        for (let i = 0; i < trades.length; i += CHUNK) {
          const res = await fetch("/api/oo/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trades: trades.slice(i, i + CHUNK), file: file.name }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          r.added += j.added;
          r.duplicates += j.duplicates;
          if (j.invalid) r.errors.push(`${j.invalid} rows rejected by server validation`);
        }
      } catch (e) {
        r.errors.push((e as Error).message);
      }
      r.done = true;
      setResults([...out]);
    }
    setBusy(false);
  }

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
        <label className="block">
          <span className="sr-only">Choose CSV files</span>
          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            disabled={busy}
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
            className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-4 file:py-2 file:text-ink"
          />
        </label>
        {results.map((r) => (
          <div key={r.name} className="rounded-lg bg-surface-2 p-3 text-sm">
            <div className="font-semibold">{r.name}</div>
            <div className="text-ink-2">
              {r.done ? "✓" : "…"} parsed {r.parsed} · added {r.added} · duplicates {r.duplicates}
            </div>
            {r.errors.slice(0, 5).map((e) => (
              <div key={e} className="text-loss">
                {e}
              </div>
            ))}
            {r.errors.length > 5 && <div className="text-loss">…and {r.errors.length - 5} more</div>}
          </div>
        ))}
      </section>

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
