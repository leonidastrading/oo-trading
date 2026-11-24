"use client";

import { useEffect, useState } from "react";
import { cleanSmas, SMA_CHOICES, SMA_LIMIT, SMA_MAX, SMA_MIN, smaColors } from "@/lib/chartSmas";

/** Settings: which daily-close SMA lines the main SPX chart draws. */
export function ChartSmaSetting() {
  const [smas, setSmas] = useState<number[] | null>(null);
  const [custom, setCustom] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/settings/chart-smas", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { smas?: number[] }) => setSmas(j.smas ?? []))
      .catch(() => setMsg("Could not load the setting"));
  }, []);
  async function save(next: number[]) {
    const clean = cleanSmas(next) ?? [];
    if (new Set(next).size > SMA_LIMIT) return setMsg(`At most ${SMA_LIMIT} lines`);
    setSmas(clean);
    setMsg(null);
    const res = await fetch("/api/settings/chart-smas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ smas: clean }) });
    setMsg(res.ok ? "Saved — the chart picks it up when the page is next opened." : `Save failed (${res.status})`);
  }
  const on = smas ?? [];
  const options = [...new Set([...SMA_CHOICES, ...on])].sort((a, b) => a - b);
  const colors = Object.fromEntries(smaColors(on).map((c) => [c.n, c.color]));
  const addCustom = () => {
    const n = Number(custom);
    if (!Number.isInteger(n) || n < SMA_MIN || n > SMA_MAX) return setMsg(`Enter a whole number of days, ${SMA_MIN}–${SMA_MAX}`);
    setCustom("");
    if (!on.includes(n)) void save([...on, n]);
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((n) => (
          <label key={n} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              disabled={smas === null}
              checked={on.includes(n)}
              onChange={(e) => void save(e.target.checked ? [...on, n] : on.filter((x) => x !== n))}
            />
            <span className="text-ink">{n}-day</span>
            {colors[n] && <span className="inline-block h-0.5 w-5" style={{ background: colors[n].replace(/[\d.]+\)$/, "1)") }} />}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          Other period (days)
          <input
            className="block w-24 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink"
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
            placeholder="21"
          />
        </label>
        <button className="rounded-lg border border-border px-3 py-1.5" onClick={addCustom}>
          Add
        </button>
      </div>
      <p className="text-xs text-muted">
        Simple moving averages of SPX daily closes, drawn as faint lines on the Live page chart (all timeframes). The chart&apos;s own SMA button
        still hides or shows them all at once. Untick everything to show none. Up to {SMA_LIMIT} lines.
      </p>
      {msg && <p className="text-xs text-ink-2">{msg}</p>}
    </div>
  );
}
