"use client";

import { useEffect, useState } from "react";
import type { StockSettings as S, StoredSettings } from "@/lib/stocks/rules";
import { formatDateTimeET } from "@/lib/time";

const FIELDS: { key: Exclude<keyof S, "dryRun">; label: string; hint: string }[] = [
  { key: "shares", label: "Live shares per idea", hint: "fixed size of every live order" },
  { key: "riskPct", label: "Shadow risk per idea, % of account", hint: "full-size risk to the stop" },
  { key: "maxPositionPct", label: "Max position, % of account", hint: "caps the shadow size" },
  { key: "maxOpen", label: "Max open ideas", hint: "" },
  { key: "maxPerWeek", label: "Max new ideas per week", hint: "Mon–Fri" },
  { key: "weeklyLossPct", label: "Weekly loss lockout, % of account", hint: "shadow P/L; blocks until Monday" },
  { key: "maxGrossPct", label: "Max gross exposure, % of account", hint: "shadow long + short" },
  { key: "maxNetPct", label: "Max net exposure, ± % of account", hint: "shadow long − short" },
];

/** Stock Trades guardrails. Loosening waits 24 hours (enforced on the server); tightening applies at once. */
export function StockSettings() {
  const [data, setData] = useState<{ settings: S; pending: StoredSettings["pending"]; liveSwitch: boolean } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    fetch("/api/stocks/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setData(j);
        setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(j.settings[f.key])])));
      })
      .catch(() => setMsg("Could not load Stock Trades settings"));
  useEffect(() => {
    void load();
  }, []);
  const save = async (patch: Record<string, unknown>) => {
    setMsg(null);
    const r = await fetch("/api/stocks/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    setMsg(
      j.error ?? (j.errors?.length ? j.errors.join("; ") : [j.applied?.length ? `Applied: ${j.applied.join(", ")}` : "", j.delayed?.length ? `In 24 hours: ${j.delayed.join(", ")}` : ""].filter(Boolean).join(" · ") || "No change"),
    );
    void load();
  };
  if (!data) return <p className="text-sm text-muted">{msg ?? "Loading…"}</p>;
  const dry = data.settings.dryRun;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-lg px-2.5 py-1 font-bold ${dry ? "bg-warn/20 text-warn" : "bg-loss/20 text-loss"}`}>{dry ? "DRY RUN" : "LIVE"}</span>
        {dry ? (
          <button
            className="rounded-lg border border-loss/60 px-3 py-1.5 text-loss"
            onClick={() => {
              const t = prompt("Switch Stock Trades to LIVE orders. Type LIVE to confirm.");
              if (t === "LIVE") void save({ dryRun: false, confirm: "LIVE" });
            }}
          >
            Go live…
          </button>
        ) : (
          <button className="rounded-lg border border-border px-3 py-1.5" onClick={() => void save({ dryRun: true })}>
            Back to dry run
          </button>
        )}
        <span className="text-xs text-muted">Server live switch: {data.liveSwitch ? "on" : "off (live orders blocked)"}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-xs text-muted">
            {f.label} {f.hint && <span>({f.hint})</span>}
            <input
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink"
              inputMode="decimal"
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <button
        className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-page"
        onClick={() => void save(Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])])))}
      >
        Save guardrails
      </button>
      {data.pending.length > 0 && (
        <ul className="text-xs text-warn">
          {data.pending.map((p) => (
            <li key={p.key}>
              {p.key} → {String(p.value)} takes effect {formatDateTimeET(p.effectiveAt)}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="text-xs text-ink-2">{msg}</p>}
      <p className="text-xs text-muted">Raising a limit takes effect 24 hours later; lowering one applies now. Changes are logged on the Stocks tab.</p>
    </div>
  );
}
