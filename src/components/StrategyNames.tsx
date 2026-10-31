"use client";

import { useEffect, useState } from "react";
import { MAX_NAME } from "@/lib/strategyNames";
import { publishStrategyNames } from "./useStrategyNames";

/** What each strategy is, so the list reads like the book. */
const HINT: Record<string, string> = {
  Long: "0DTE put spread, 100 wide (floating 9:32–13:45)",
  Short: "0DTE call spread, 100 wide (floating 9:32–14:30)",
  "8SMA IC": "13:30 iron condor, 25 put / 100 call wings",
  "$8 IC": "13:35 iron condor, 50 / 50",
  Dip: "Dip Add-On, 1-lot $8 IC copy (own order)",
  "5d IC": "13:30 & 14:30 iron condor, 100 / 100",
  BWB: "13:50 / 14:20 / 14:50 put BWB, +30 / −45",
  "2DTE": "15:30 put spread, 75 wide, 2 days out",
  "VIX>30 1DTE": "13:30 put spread, 50 wide, 1 day",
  "VIX-up PS": "15:50 two 1DTE put spreads, 50 wide",
  FOMC: "14:35 long straddle on FOMC days",
};

/** Rename how the book strategies are shown on the chart, positions and Scorecard. */
export function StrategyNames() {
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/strategy-names", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { strategies: string[]; names: Record<string, string> }) => {
        setList(j.strategies ?? []);
        setSaved(j.names ?? {});
        setDraft(j.names ?? {});
      })
      .catch(() => setMsg("Could not load strategy names"));
  }, []);

  const dirty = list.some((s) => (draft[s] ?? "").trim() !== (saved[s] ?? ""));

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/strategy-names", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: Object.fromEntries(list.map((s) => [s, (draft[s] ?? "").trim()])) }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg(j.error ?? `Save failed (${res.status})`);
    setSaved(j.names ?? {});
    setDraft(j.names ?? {});
    publishStrategyNames(j.names ?? {});
    setMsg("Saved.");
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {list.map((s) => (
          <label key={s} className="flex flex-col gap-1 rounded-lg bg-surface-2 p-2 text-sm">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-ink">{s}</span>
              <span className="truncate text-xs text-muted">{HINT[s] ?? ""}</span>
            </span>
            <input
              value={draft[s] ?? ""}
              maxLength={MAX_NAME}
              placeholder={s}
              onChange={(e) => setDraft({ ...draft, [s]: e.target.value })}
              className="rounded border border-border bg-surface px-2 py-1 text-ink"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy || !dirty} onClick={save} className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink disabled:opacity-50">
          {busy ? "Saving…" : "Save names"}
        </button>
        <button
          disabled={busy || !list.some((s) => draft[s])}
          onClick={() => setDraft({})}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-2 disabled:opacity-50"
        >
          Clear all (then Save)
        </button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
      <p className="text-xs text-muted">
        Leave a box empty to keep the default name. Names show on the SPX chart, the Live/Today positions and the Scorecard; up to {MAX_NAME}{" "}
        characters.
      </p>
    </div>
  );
}
