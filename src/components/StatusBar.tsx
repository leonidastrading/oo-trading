"use client";

import { useEffect, useState } from "react";
import { formatTimeET } from "@/lib/time";

const MANUAL_MS = 30_000;

export interface StatusMeta {
  now: number;
  phase: "open" | "final" | "closed";
  pollMs: number | null;
  errors: string[];
  delayed: boolean;
  manualRefreshBlocked: boolean;
}

export function StatusBar({
  meta,
  fetchedAt,
  loading,
  clientError,
  onRefresh,
}: {
  meta: StatusMeta | null;
  fetchedAt: number | null;
  loading: boolean;
  clientError: string | null;
  onRefresh: () => void;
}) {
  const [lastManual, setLastManual] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const wait = now ? Math.max(0, Math.ceil((lastManual + MANUAL_MS - now) / 1000)) : 0;
  const every = meta?.pollMs ? (meta.pollMs >= 60_000 ? `${Math.round(meta.pollMs / 60_000)} min` : `${Math.round(meta.pollMs / 1000)}s`) : null;
  const phaseLabel =
    meta?.phase === "closed" || !meta
      ? "Market closed"
      : `${meta.phase === "final" ? "Final 45 min" : "Market open"}${every ? ` · ${every} refresh` : ""}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${meta?.phase === "closed" || !meta ? "bg-muted" : "bg-gain"}`}
          />
          {meta ? phaseLabel : "Loading…"}
        </span>
        <span className="num">Last updated {formatTimeET(fetchedAt)}</span>
        <button
          onClick={() => {
            const t = Date.now();
            setLastManual(t);
            setNow(t);
            onRefresh();
          }}
          disabled={loading || wait > 0}
          className="ml-auto rounded-lg border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : wait > 0 ? `Refresh (${wait}s)` : "Refresh"}
        </button>
      </div>
      {meta?.delayed && (
        <Banner tone="warn">Data delayed — last good data is from {formatTimeET(fetchedAt)}. Retrying automatically.</Banner>
      )}
      {meta?.manualRefreshBlocked && <Banner tone="info">Manual refresh is limited to once per 30s; showing cached data.</Banner>}
      {[...(meta?.errors ?? []), ...(clientError ? [clientError] : [])].map((e) => (
        <Banner key={e} tone="error">
          {e}
          {fetchedAt ? ` — showing last good data from ${formatTimeET(fetchedAt)}.` : ""}
        </Banner>
      ))}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "warn" | "error" | "info"; children: React.ReactNode }) {
  const styles = {
    warn: "border-warn/40 bg-warn/10 text-warn",
    error: "border-loss/40 bg-loss/10 text-loss",
    info: "border-border bg-surface-2 text-ink-2",
  }[tone];
  const icon = { warn: "⚠", error: "✕", info: "ℹ" }[tone];
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex gap-2 rounded-lg border px-3 py-2 text-sm ${styles}`}>
      <span aria-hidden>{icon}</span>
      <span>{children}</span>
    </div>
  );
}
