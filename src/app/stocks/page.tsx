"use client";

import { useState } from "react";
import type { StocksData } from "@/app/api/stocks/route";
import { money, plClass } from "@/components/format";
import { StockPnlChart } from "@/components/StockPnlChart";
import { StockTradeChart } from "@/components/StockTradeChart";
import { usePoll } from "@/components/usePoll";
import type { Check, Trade } from "@/lib/stocks/rules";
import { excessReturn, SOURCES } from "@/lib/stocks/rules";
import { formatDateTimeET } from "@/lib/time";

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const r2 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);
const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function IdeaForm({ onDone, dry }: { onDone: () => void; dry: boolean }) {
  const blank = { ticker: "", direction: "long", entryType: "market", limitPrice: "", stop: "", target: "", thesis: "", days: "", source: "", benchmark: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  type Res = {
    ok: boolean;
    preview?: boolean;
    errors?: string[];
    checks?: Check[];
    order?: unknown;
    error?: string;
    sizing?: { liveShares: number; entryRef: number; accountValue: number | null; shadow: { shares: number; position: number; positionPct: number; risk: number; riskPct: number; capped: boolean } };
  };
  const [res, setRes] = useState<Res | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const complete =
    f.ticker && f.stop && f.thesis.trim() && f.days && f.source && (f.entryType === "market" || f.limitPrice);
  const payload = () => ({
    ...f,
    limitPrice: f.entryType === "limit" ? Number(f.limitPrice) : null,
    stop: Number(f.stop),
    target: f.target ? Number(f.target) : null,
    days: Number(f.days),
  });
  const key = JSON.stringify(f);
  // Step 1: check and size (nothing logged or sent). Step 2: confirm — the server re-runs every check.
  async function check() {
    setBusy(true);
    setRes(null);
    const { json } = await post("/api/stocks/ideas", { ...payload(), preview: true });
    setRes(json as Res);
    setPreviewed(json.ok ? key : null);
    setBusy(false);
  }
  async function submit() {
    setBusy(true);
    const { json } = await post("/api/stocks/ideas", payload());
    setRes(json as Res);
    setPreviewed(null);
    setBusy(false);
    if (json.ok) setF(blank);
    onDone();
  }
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold text-accent">New idea</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-xs text-muted">
          Ticker
          <input className={inputCls} value={f.ticker} onChange={(e) => setF({ ...f, ticker: e.target.value.toUpperCase() })} placeholder="AAPL" />
        </label>
        <label className="text-xs text-muted">
          Direction
          <select className={inputCls} value={f.direction} onChange={set("direction")}>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          Entry
          <select className={inputCls} value={f.entryType} onChange={set("entryType")}>
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          Limit price
          <input className={inputCls} inputMode="decimal" disabled={f.entryType !== "limit"} value={f.limitPrice} onChange={set("limitPrice")} />
        </label>
        <label className="text-xs text-muted">
          Stop
          <input className={inputCls} inputMode="decimal" value={f.stop} onChange={set("stop")} />
        </label>
        <label className="text-xs text-muted">
          Target (optional)
          <input className={inputCls} inputMode="decimal" value={f.target} onChange={set("target")} />
        </label>
        <label className="text-xs text-muted">
          Time frame (days)
          <input className={inputCls} inputMode="numeric" value={f.days} onChange={set("days")} />
        </label>
        <label className="text-xs text-muted">
          Source
          <select className={inputCls} value={f.source} onChange={set("source")}>
            <option value="">Choose…</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs text-muted">
        Benchmark ETF (optional, e.g. XBI, SMH, XLE — scored against it as well as SPY)
        <input className={inputCls} value={f.benchmark} onChange={(e) => setF({ ...f, benchmark: e.target.value.toUpperCase() })} placeholder="SPY is always used" />
      </label>
      <label className="block text-xs text-muted">
        Thesis (1–3 sentences)
        <textarea className={inputCls} rows={2} value={f.thesis} onChange={set("thesis")} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded-lg border border-accent px-4 py-2 font-semibold text-accent disabled:opacity-40" disabled={!complete || busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check & size"}
        </button>
        <button
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-page disabled:opacity-40"
          disabled={busy || previewed !== key}
          onClick={() => void submit()}
          title={previewed !== key ? "Check & size first" : undefined}
        >
          {dry ? "Confirm dry run" : "Confirm & send order"}
        </button>
        <span className="text-xs text-muted">Size is fixed in Settings. Every check runs on the server.</span>
      </div>
      {res && (
        <div className={`rounded-xl border p-3 text-sm ${res.ok ? "border-gain/40" : "border-loss/40"}`}>
          <div className={`font-semibold ${res.ok ? "text-gain" : "text-loss"}`}>
            {res.preview ? (res.ok ? "All checks pass — review the size, then confirm" : "Blocked") : res.ok ? (dry ? "Dry run logged (nothing sent)" : "Order sent") : "Blocked"}
          </div>
          {res.sizing && (
            <div className="my-2 grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg bg-surface-2 p-2 text-xs sm:grid-cols-3">
              <span>
                Live shares: <b>{res.sizing.liveShares}</b>
              </span>
              <span>
                Shadow shares: <b>{res.sizing.shadow.shares.toLocaleString("en-US")}</b>
              </span>
              <span>
                Entry ref: <b>{res.sizing.entryRef}</b>
              </span>
              <span>
                Shadow position: <b>{money(res.sizing.shadow.position)}</b> ({res.sizing.shadow.positionPct}% of account)
              </span>
              <span>
                Shadow risk: <b>{money(res.sizing.shadow.risk)}</b> ({res.sizing.shadow.riskPct}% of account)
              </span>
              {res.sizing.shadow.capped && <span className="text-warn">Max position cap binds: risk is below the target %</span>}
            </div>
          )}
          {res.error && <div className="text-loss">{res.error}</div>}
          {!res.checks?.length && res.errors?.map((e) => <div key={e} className="text-loss">{e}</div>)}
          {res.checks && (
            <ul className="mt-1 space-y-0.5">
              {res.checks.map((c) => (
                <li key={c.name} className={c.ok ? "text-ink-2" : "text-loss"}>
                  {c.ok ? "✓" : "✗"} <span className="font-medium">{c.name}</span> — {c.detail}
                </li>
              ))}
            </ul>
          )}
          {res.order !== undefined && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted">Order {res.ok && dry ? "it would send" : "JSON"}</summary>
              <pre className="mt-1 overflow-x-auto text-[11px] text-ink-2">{JSON.stringify(res.order, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

const xFmt = (x: { pct: number; r: number | null } | null) => (x ? `${x.pct >= 0 ? "+" : ""}${x.pct.toFixed(2)}% (${x.r === null ? "—" : `${x.r >= 0 ? "+" : ""}${x.r.toFixed(2)}R`})` : "—");

function OpenTrade({ t, last, spy, bench, onDone }: { t: Trade; last: number | null; spy: number | null; bench: number | null; onDone: () => void }) {
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const dir = t.direction === "long" ? 1 : -1;
  const entry = t.entryPrice ?? null;
  const pl = entry !== null && last !== null ? (last - entry) * dir * t.shares : null;
  const r = entry !== null && last !== null && t.riskPerShare ? ((last - entry) * dir) / t.riskPerShare : null;
  const shadowPl = entry !== null && last !== null ? (last - entry) * dir * t.shadowShares : null;
  const vsSpy = entry !== null && last !== null ? excessReturn(t, last, t.spyEntry, spy) : null;
  const vsBench = entry !== null && last !== null && t.benchmark ? excessReturn(t, last, t.benchEntry, bench) : null;
  const act = async (action: string, value?: number) => {
    setMsg(null);
    const { json } = await post("/api/stocks/trade", { id: t.id, action, value });
    setMsg(json.ok ? "Done" : String(json.error ?? "Failed"));
    onDone();
  };
  return (
    <div className="rounded-xl bg-surface-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-bold">{t.ticker}</span> <span className={t.direction === "long" ? "text-gain" : "text-loss"}>{t.direction}</span>{" "}
          <span className="text-muted">
            · {t.shares} sh · {t.status} · {t.source} · exit by {t.exitBy}
            {t.mode === "dry" ? " · DRY RUN" : ""}
          </span>
        </div>
        <div className={`font-semibold ${plClass(pl ?? 0)}`}>
          {pl === null ? "—" : money(pl, { sign: true, cents: true })} {r !== null && <span className="text-xs">({r.toFixed(2)}R)</span>}
        </div>
      </div>
      <div className="mt-1 text-xs text-ink-2">
        entry {entry ?? (t.entryType === "limit" ? `limit ${t.limitPrice} (working)` : "pending")} · last {r2(last)} · stop {t.stop} · target {t.target ?? "—"} · risk/sh {t.riskPerShare} · shadow{" "}
        {t.shadowShares} sh
      </div>
      {entry !== null && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg bg-surface p-2 text-xs sm:grid-cols-3">
          <span>
            Unrealized: <b className={plClass(pl ?? 0)}>{pl === null ? "—" : money(pl, { sign: true, cents: true })}</b> {r !== null && `(${r >= 0 ? "+" : ""}${r.toFixed(2)}R)`}
          </span>
          <span>
            Realized: <b>{money(0, { cents: true })}</b> <span className="text-muted">(until it closes)</span>
          </span>
          <span>
            Shadow unrealized: <b className={plClass(shadowPl ?? 0)}>{shadowPl === null ? "—" : money(shadowPl, { sign: true })}</b>
          </span>
          <span>
            vs SPY: <b className={plClass(vsSpy?.pct ?? 0)}>{xFmt(vsSpy)}</b>
          </span>
          {t.benchmark && (
            <span>
              vs {t.benchmark}: <b className={plClass(vsBench?.pct ?? 0)}>{xFmt(vsBench)}</b>
            </span>
          )}
        </div>
      )}
      <div className="mt-1 text-xs text-muted">{t.thesis}</div>
      <StockTradeChart trade={t} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={`${inputCls} w-24`} inputMode="decimal" placeholder="new stop" value={stop} onChange={(e) => setStop(e.target.value)} />
        <button className="rounded-lg border border-border px-2 py-1 text-xs" onClick={() => void act("stop", Number(stop))} disabled={!stop}>
          Tighten stop
        </button>
        <input className={`${inputCls} w-24`} inputMode="decimal" placeholder="new target" value={target} onChange={(e) => setTarget(e.target.value)} />
        <button className="rounded-lg border border-border px-2 py-1 text-xs" onClick={() => void act("target", Number(target))} disabled={!target}>
          Change target
        </button>
        <button
          className="rounded-lg border border-loss/50 px-2 py-1 text-xs text-loss"
          onClick={() => {
            if (confirm(`Close ${t.ticker} at market?`)) void act("close");
          }}
        >
          {t.status === "pending" ? "Cancel entry" : "Close at market"}
        </button>
        {msg && <span className="text-xs text-ink-2">{msg}</span>}
      </div>
    </div>
  );
}

export default function StocksPage() {
  const { data, error, refresh } = usePoll<StocksData>("/api/stocks");
  const [busy, setBusy] = useState(false);
  const [flatMsg, setFlatMsg] = useState<string | null>(null);
  const [shownChart, setShownChart] = useState<string | null>(null);
  if (!data) return <div className="text-sm text-muted">{error ?? "Loading…"}</div>;
  const dry = data.mode === "dry";
  const open = data.trades.filter((t) => ["pending", "open", "closing"].includes(t.status) && t.mode === data.mode);
  const closed = data.trades.filter((t) => t.status === "closed" || t.status === "cancelled");
  const s = data.summary;
  const chartTrade = closed.find((t) => t.id === shownChart) ?? null;
  const kill = async (on: boolean) => {
    setBusy(true);
    await post("/api/stocks/kill", { on });
    setBusy(false);
    refresh();
  };
  const flatten = async () => {
    const typed = prompt('Close ALL Stock Trades positions at market. Type FLATTEN to confirm.');
    if (typed !== "FLATTEN") return;
    setBusy(true);
    const { json } = await post("/api/stocks/flatten", { confirm: "FLATTEN" });
    setFlatMsg(json.ok ? `Flattened ${json.closed}` : `Problems: ${(json.errors as string[] | undefined)?.join("; ") ?? json.error}`);
    setBusy(false);
    refresh();
  };

  return (
    <div className="space-y-5">
      <section className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted">Trading account</div>
          <div className="text-lg font-bold">
            {data.account ? `${data.account.nickname ?? "Schwab"} ••${data.account.last4}` : "Not connected"}
            {data.account?.type && <span className="ml-2 text-sm font-normal text-muted">{data.account.type}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-lg px-2.5 py-1 text-sm font-bold ${dry ? "bg-warn/20 text-warn" : "bg-loss/20 text-loss"}`}>{dry ? "DRY RUN" : "LIVE"}</span>
          {!dry && !data.liveSwitch && <span className="text-xs text-loss">server live switch off — orders blocked</span>}
          <button
            disabled={busy}
            onClick={() => void kill(!data.kill)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${data.kill ? "bg-loss text-page" : "border border-loss/60 text-loss"}`}
          >
            {data.kill ? "Kill switch ON — turn off" : "Kill switch"}
          </button>
          <button disabled={busy} onClick={() => void flatten()} className="rounded-lg border border-loss/60 px-3 py-1.5 text-sm text-loss">
            Flatten all…
          </button>
        </div>
        {flatMsg && <div className="w-full text-sm">{flatMsg}</div>}
        {data.meta.errors.length > 0 && <div className="w-full text-xs text-loss">{data.meta.errors.join(" · ")}</div>}
      </section>

      {data.alerts.map((a) => (
        <div key={a.id} className="card flex items-start justify-between gap-3 border-loss/60 p-3 text-sm text-loss">
          <span>
            ⚠ {a.text} <span className="text-xs text-muted">{formatDateTimeET(a.at)}</span>
          </span>
          <button className="text-xs underline" onClick={() => void post("/api/stocks/alerts", { id: a.id }).then(refresh)}>
            Dismiss
          </button>
        </div>
      ))}
      {data.sizeUp && <div className="card border-gain/60 p-3 text-sm font-semibold text-gain">{data.sizeUp} (Change the live size in Settings; it takes effect 24 hours later.)</div>}

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold text-accent">Scorecard {dry ? "(dry run)" : "(live)"}</h2>
          <span className="text-xs text-muted">
            this week shadow P/L {money(data.lockouts.weekShadowPl, { sign: true })}
            {data.lockouts.streakUntil ? ` · losing-streak lock until ${data.lockouts.streakUntil}` : ""}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Trades" value={String(s.trades)} />
          <Stat label="Win %" value={pct(s.winPct)} />
          <Stat label="Avg R" value={r2(s.avgR)} tone={plClass(s.avgR ?? 0)} />
          <Stat label="Total R" value={r2(s.totalR)} tone={plClass(s.totalR)} />
          <Stat
            label="Shadow P/L"
            value={`${money(s.shadowPl, { sign: true })}${s.shadowPlPct !== null && s.shadowPlPct !== undefined ? ` (${s.shadowPlPct >= 0 ? "+" : ""}${s.shadowPlPct}%)` : ""}`}
            tone={plClass(s.shadowPl)}
          />
          <Stat label="P/L (actual)" value={money(s.pl, { sign: true, cents: true })} tone={plClass(s.pl)} />
          <Stat label="Avg excess vs SPY" value={s.avgExcess === null ? "—" : `${s.avgExcess >= 0 ? "+" : ""}${s.avgExcess.toFixed(2)}%`} tone={plClass(s.avgExcess ?? 0)} />
          <Stat label="Avg excess R" value={s.avgExcessR === null ? "—" : `${s.avgExcessR >= 0 ? "+" : ""}${s.avgExcessR.toFixed(2)}R`} tone={plClass(s.avgExcessR ?? 0)} />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            Shadow gross exposure: <b>{money(data.exposure.gross)}</b>
            {data.exposure.grossPct !== null && ` (${data.exposure.grossPct.toFixed(1)}% / max ${data.settings.maxGrossPct}%)`}
          </span>
          <span>
            Net: <b>{money(data.exposure.net, { sign: true })}</b>
            {data.exposure.netPct !== null && ` (${data.exposure.netPct >= 0 ? "+" : ""}${data.exposure.netPct.toFixed(1)}% / ±${data.settings.maxNetPct}%)`}
          </span>
          {data.accountValue && <span className="text-muted">account {money(data.accountValue)}</span>}
        </div>
        <StockPnlChart trades={data.trades.filter((t) => t.mode === data.mode)} />
        <div className="grid gap-3 md:grid-cols-2">
          {[
            ["By source", s.bySource],
            ["By direction", s.byDirection],
          ].map(([title, rows]) => (
            <div key={title as string} className="overflow-x-auto">
              <div className="mb-1 text-sm font-semibold text-ink-2">{title as string}</div>
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th></th>
                    <th>Trades</th>
                    <th>Win %</th>
                    <th>Avg R</th>
                    <th>Total R</th>
                    <th>Shadow P/L</th>
                    <th>Avg excess</th>
                    <th>Excess R</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows as typeof s.bySource).map((b) => (
                    <tr key={b.key}>
                      <td>{b.key}</td>
                      <td className="num">{b.trades}</td>
                      <td className="num">{pct(b.winPct)}</td>
                      <td className="num">{r2(b.avgR)}</td>
                      <td className="num">{r2(b.totalR)}</td>
                      <td className={`num ${plClass(b.shadowPl)}`}>{money(b.shadowPl, { sign: true })}</td>
                      <td className={`num ${plClass(b.avgExcess ?? 0)}`}>{b.avgExcess === null ? "—" : `${b.avgExcess.toFixed(2)}%`}</td>
                      <td className={`num ${plClass(b.avgExcessR ?? 0)}`}>{r2(b.avgExcessR)}</td>
                    </tr>
                  ))}
                  {!(rows as typeof s.bySource).length && (
                    <tr>
                      <td colSpan={8} className="text-muted">
                        No closed trades yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-sm font-semibold text-ink-2">Rule-break attempts ({data.blocks.length})</div>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {data.blocks.map((b) => (
              <li key={b.id}>
                <span className="text-muted">{formatDateTimeET(b.at)}</span> {b.ticker && <span className="font-semibold">{b.ticker}</span>} <span className="text-loss">{b.text}</span>
              </li>
            ))}
            {!data.blocks.length && <li className="text-muted">None</li>}
          </ul>
        </div>
      </section>

      <IdeaForm dry={dry} onDone={refresh} />

      <section className="card space-y-2 p-4">
        <h2 className="font-bold text-accent">Open ({open.length} of {data.settings.maxOpen})</h2>
        {open.map((t) => (
          <OpenTrade
            key={t.id}
            t={t}
            last={data.quotes[t.ticker] ?? null}
            spy={data.quotes.SPY ?? null}
            bench={t.benchmark ? (data.quotes[t.benchmark] ?? null) : null}
            onDone={refresh}
          />
        ))}
        {!open.length && <p className="text-sm text-muted">No open ideas.</p>}
      </section>

      <section className="card space-y-2 overflow-x-auto p-4">
        <h2 className="font-bold text-accent">Closed</h2>
        <table className="data w-full text-xs">
          <thead>
            <tr>
              <th>Closed</th>
              <th>Ticker</th>
              <th>Dir</th>
              <th>Source</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Why</th>
              <th>Slip</th>
              <th>P/L</th>
              <th>%</th>
              <th>R</th>
              <th>Shadow</th>
              <th>vs SPY</th>
              <th>vs ETF</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {closed.map((t) => (
              <tr
                key={t.id}
                title={t.thesis}
                onClick={() => setShownChart(shownChart === t.id ? null : t.id)}
                className={`cursor-pointer ${shownChart === t.id ? "bg-surface-2" : ""}`}
              >
                <td>{t.exitTime ? formatDateTimeET(t.exitTime) : "—"}</td>
                <td className="font-semibold">{t.ticker}</td>
                <td>{t.direction}</td>
                <td>{t.source}</td>
                <td className="num">{t.entryPrice ?? "—"}</td>
                <td className="num">{t.exitPrice ?? "—"}</td>
                <td>{t.status === "cancelled" ? "not filled" : t.exitReason}</td>
                <td className="num">{t.slippage ?? "—"}</td>
                <td className={`num ${plClass(t.pl ?? 0)}`}>{t.pl === null || t.pl === undefined ? "—" : money(t.pl, { sign: true, cents: true })}</td>
                <td className="num">{t.plPct ?? "—"}</td>
                <td className="num">{t.r ?? "—"}</td>
                <td className={`num ${plClass(t.shadowPl ?? 0)}`}>{t.shadowPl === null || t.shadowPl === undefined ? "—" : money(t.shadowPl, { sign: true })}</td>
                <td className={`num ${plClass(t.excess ?? 0)}`}>{typeof t.excess === "number" ? xFmt({ pct: t.excess, r: t.excessR ?? null }) : "—"}</td>
                <td className={`num ${plClass(t.benchExcess ?? 0)}`}>
                  {t.benchmark ? `${t.benchmark} ${typeof t.benchExcess === "number" ? xFmt({ pct: t.benchExcess, r: t.benchExcessR ?? null }) : "—"}` : "—"}
                </td>
                <td>{t.mode}</td>
              </tr>
            ))}
            {!closed.length && (
              <tr>
                <td colSpan={15} className="text-muted">
                  Nothing closed yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {chartTrade && (
          <div>
            <div className="text-sm font-semibold">
              {chartTrade.ticker} {chartTrade.direction} · {chartTrade.exitReason} · {chartTrade.r ?? "—"}R
            </div>
            <StockTradeChart trade={chartTrade} />
          </div>
        )}
        {closed.length > 0 && <p className="text-xs text-muted">Tap a row for its chart.</p>}
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="font-bold text-accent">Order &amp; block log</h2>
        <ul className="max-h-96 space-y-1 overflow-y-auto text-xs">
          {data.log.map((l) => (
            <li key={l.id}>
              <span className="text-muted">{formatDateTimeET(l.at)}</span> <span className="uppercase text-muted">[{l.mode} · {l.kind}]</span>{" "}
              {l.ticker && <span className="font-semibold">{l.ticker} </span>}
              <span className={l.kind === "block" || l.kind === "error" || l.kind === "alert" ? "text-loss" : ""}>{l.text}</span>
            </li>
          ))}
          {!data.log.length && <li className="text-muted">Empty</li>}
        </ul>
      </section>
      <p className="text-xs text-muted">
        Guardrails ({data.mode}): {data.settings.shares} live share(s) per idea · shadow size {data.settings.riskPct}% risk, max {data.settings.maxPositionPct}%
        position · gross ≤ {data.settings.maxGrossPct}%, net ±{data.settings.maxNetPct}% · max {data.settings.maxOpen} open · {data.settings.maxPerWeek} new ideas per
        week · weekly shadow-loss lockout {data.settings.weeklyLossPct}% · entries 9:45–15:45 ET. Change them in Settings (loosening waits
        24 hours).
      </p>
    </div>
  );
}
