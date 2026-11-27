"use client";

import { useEffect, useState } from "react";
import type { StockSettings as S, StoredSettings } from "@/lib/stocks/rules";
import { formatDateTimeET } from "@/lib/time";

const FIELDS: { key: Exclude<keyof S, "dryRun" | "sizeByRisk" | "sizeByRiskAt" | "loosenedAt">; label: string; hint: string }[] = [
  { key: "riskPct", label: "Risk per trade, % of account", hint: "what a stop-out loses; sets the size" },
  { key: "maxPositionPct", label: "Max position, % of account", hint: "no position bigger than this, whatever the stop" },
  { key: "defaultPositionPct", label: "Default position size, % of account", hint: "what a new idea's size starts at; 0.1 to the max position" },
  { key: "defaultStopPct", label: "Default stop distance, % from entry", hint: "prefilled when an idea has no stop; 0.5 to 25" },
  { key: "shares", label: "Fixed shares per order", hint: "used when account sizing is off" },
  { key: "maxOpen", label: "Max open ideas", hint: "" },
  { key: "maxPerWeek", label: "Max new ideas per week", hint: "Mon–Fri" },
  { key: "weeklyLossPct", label: "Weekly loss lockout, % of account", hint: "shadow P/L; blocks until Monday" },
  { key: "maxGrossPct", label: "Max gross exposure, % of account", hint: "shadow long + short" },
  { key: "maxNetPct", label: "Max net exposure, ± % of account", hint: "shadow long − short" },
];

/** Stock Trades guardrails. Loosening waits 24 hours (enforced on the server); tightening applies at once. */
export function StockSettings() {
  const [data, setData] = useState<{ settings: S; pending: StoredSettings["pending"]; liveSwitch: boolean; riskLive: boolean } | null>(null);
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
      <div className="space-y-1 rounded-lg bg-surface-2 p-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={data.settings.sizeByRisk} onChange={(e) => void save({ sizeByRisk: e.target.checked })} />
          <span className="font-semibold">Size orders from the account</span>
        </label>
        <p className="text-xs text-muted">
          On: each order is sized so a stop-out loses the &quot;Risk per trade&quot; % of the account, and never more than &quot;Max position&quot; % in one stock. Off: every
          order is the fixed share count.{" "}
          {data.settings.sizeByRisk &&
            (data.riskLive
              ? "In force for dry-run and live orders."
              : `In force for dry-run orders now; for live orders from ${formatDateTimeET(data.settings.sizeByRiskAt + 24 * 3600_000)} (until then live orders use the fixed shares).`)}
        </p>
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
      <p className="text-xs text-muted">
        The two sizes are different things: &quot;Risk per trade&quot; is what a stop-out loses; &quot;Default position size&quot; is how much of the account goes into
        the stock. With a 1% position and an 8% stop, a stop-out loses 0.08% of the account. Both defaults only prefill the entry form, where you can change them per idea.
      </p>
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
      <p className="text-xs text-muted">
        {dry
          ? "Dry run: every change applies now. After raising a limit, going live waits 24 hours."
          : "Live: raising a limit takes effect 24 hours later; lowering one applies now."}{" "}
        Changes are logged on the Stocks tab.
      </p>
    </div>
  );
}
