"use client";

import { useEffect, useMemo, useState } from "react";
import type { StocksData } from "@/app/api/stocks/route";
import { money, plClass } from "@/components/format";
import { StockPnlChart } from "@/components/StockPnlChart";
import { StockTradeChart, type ChartTrade } from "@/components/StockTradeChart";
import { usePoll } from "@/components/usePoll";
import type { Check, StockQuote, Trade } from "@/lib/stocks/rules";
import type { CardPrefill } from "@/lib/stocks/scoutCard";
import { excessReturn, SOURCES, STAGES, SUGGESTED_STOP_PCT, suggestedStop } from "@/lib/stocks/rules";
import { formatDateTimeET } from "@/lib/time";

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const r2 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);
const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink placeholder:text-muted disabled:opacity-100";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

type LiveQuote = { symbol: string; q: StockQuote | null; error?: string; at: number } | null;

/** Quote for the ticker being typed: fetched 400 ms after typing stops, then refreshed every 10 s. */
function useLiveQuote(ticker: string): LiveQuote {
  const [lq, setLq] = useState<LiveQuote>(null);
  const sym = ticker.trim().toUpperCase();
  useEffect(() => {
    if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(sym)) return;
    let off = false;
    const load = () =>
      fetch(`/api/stocks/quote?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { quote?: StockQuote | null; error?: string }) => !off && setLq({ symbol: sym, q: j.quote ?? null, error: j.error, at: Date.now() }))
        .catch(() => !off && setLq({ symbol: sym, q: null, error: "Quote failed", at: Date.now() }));
    const first = setTimeout(load, 400);
    const every = setInterval(load, 10_000);
    return () => {
      off = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [sym]);
  return lq?.symbol === sym ? lq : null;
}

function QuoteLine({ q, stop, target, limit, long }: { q: LiveQuote; stop: number; target: number; limit: number; long: boolean }) {
  if (!q) return null;
  if (!q.q) return <div className="col-span-2 text-xs text-loss md:col-span-4">{q.error ?? "No quote"}</div>;
  const { last, bid, ask, description, shortable, hardToBorrow } = q.q;
  const ref = limit > 0 ? limit : last;
  const pct = (v: number) => (ref ? (((v - ref) / ref) * 100).toFixed(2) : "–");
  const stopBad = ref != null && stop > 0 && (long ? stop >= ref : stop <= ref);
  return (
    <div className="col-span-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-2 py-1.5 text-xs md:col-span-4">
      <span className="text-ink">
        <b className="text-base">{last ?? "–"}</b> <span className="text-muted">{description}</span>
      </span>
      <span className="text-muted">
        bid {bid ?? "–"} · ask {ask ?? "–"}
      </span>
      {stop > 0 && ref != null && (
        <span className={stopBad ? "text-loss" : "text-ink-2"}>
          stop {pct(stop)}%{limit > 0 ? " from entry" : ""}
          {stopBad ? ` (wrong side for a ${long ? "long" : "short"})` : ""}
        </span>
      )}
      {target > 0 && ref != null && <span className="text-ink-2">target {pct(target)}%</span>}
      {!long && shortable === false && <span className="text-loss">not shortable</span>}
      {!long && hardToBorrow && <span className="text-warn">hard to borrow</span>}
    </div>
  );
}

interface Held {
  symbol: string;
  description: string;
  qty: number;
  avgPrice: number;
}

/** New idea — or, with `adopt`, the same form for a position already opened outside the app. */
function IdeaForm({ onDone, dry, adopt, onCancel }: { onDone: () => void; dry: boolean; adopt?: Held; onCancel?: () => void }) {
  const blank = {
    ticker: "",
    direction: "long",
    entryType: "market",
    limitPrice: "",
    stop: "",
    target: "",
    thesis: "",
    days: "",
    source: "",
    benchmark: "",
    stage: "",
    lateStageAck: false,
    ideaNotes: "",
    becauseData: "",
    catalyst: "",
    catalystDate: "",
    invalidation: "",
    priceImplies: "",
    crowding: "",
    planAdd: false,
    addTrigger: "",
  };
  const [f, setF] = useState(adopt ? { ...blank, ticker: adopt.symbol, direction: adopt.qty > 0 ? "long" : "short" } : blank);
  const endpoint = adopt ? "/api/stocks/adopt" : "/api/stocks/ideas";
  const quote = useLiveQuote(f.ticker);
  const [busy, setBusy] = useState(false);
  type Res = {
    ok: boolean;
    preview?: boolean;
    errors?: string[];
    checks?: Check[];
    order?: unknown;
    error?: string;
    overrides?: string[];
    sizing?: {
      liveShares: number;
      entryRef: number;
      accountValue: number | null;
      shadow: { shares: number; position: number; positionPct: number; risk: number; riskPct: number; capped: boolean };
      planAdd?: boolean;
      starterShadow?: number;
      addShadow?: number;
      starterPosition?: number;
      starterRisk?: number;
    };
  };
  const [res, setRes] = useState<Res | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  // The Trend Scout card the idea comes from: it sets the ticker (locked) and prefills the rest.
  const [card, setCard] = useState<{ cardId: string; cardUrl: string | null; entryHint: string; empty: string[] } | null>(null);
  const [cardNo, setCardNo] = useState("");
  const [cardErr, setCardErr] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [autoStop, setAutoStop] = useState(false);
  // Live chart for the loaded ticker, with the form's stop / target / limit drawn as lines.
  const chartTrade = useMemo<ChartTrade | null>(() => {
    if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(f.ticker)) return null;
    const stop = Number(f.stop) > 0 ? Number(f.stop) : 0;
    return {
      ticker: f.ticker,
      direction: f.direction === "short" ? "short" : "long",
      stop,
      initialStop: stop,
      target: Number(f.target) > 0 ? Number(f.target) : null,
      entryType: f.entryType === "limit" ? "limit" : f.entryType === "stop" ? "stop" : "market",
      limitPrice: f.entryType !== "market" && Number(f.limitPrice) > 0 ? Number(f.limitPrice) : null,
    };
  }, [f.ticker, f.direction, f.stop, f.target, f.entryType, f.limitPrice]);
  // 20% stop suggestion from the entry reference (the limit price for a limit entry, else the last price).
  const stopRef = f.entryType !== "market" && Number(f.limitPrice) > 0 ? Number(f.limitPrice) : (quote?.q?.last ?? 0);
  const stop20 = stopRef > 0 ? String(suggestedStop(stopRef, f.direction === "long")) : "";
  async function loadCard() {
    setCardBusy(true);
    setCardErr(null);
    try {
      const r = await fetch(`/api/stocks/card?id=${encodeURIComponent(cardNo.trim().replace(/^#/, ""))}`, { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; error?: string; prefill?: CardPrefill };
      if (!j.ok || !j.prefill) return setCardErr(j.error ?? "Couldn't load the card");
      const p = j.prefill;
      if (adopt && p.ticker !== adopt.symbol) return setCardErr(`Card ${p.cardId} is for ${p.ticker}, not ${adopt.symbol}`);
      const base = adopt ? f : blank;
      const next = { ...base, ticker: p.ticker, source: "trend scout" };
      const labels: Record<string, string> = {
        stop: "stop", days: "time frame", thesis: "thesis", stage: "stage",
        becauseData: "because of this data", catalyst: "catalyst", invalidation: "what proves it wrong",
      };
      const empty: string[] = [];
      for (const k of ["stop", "target", "days", "thesis", "invalidation", "ideaNotes", "becauseData", "catalyst", "catalystDate", "priceImplies", "stage", "crowding", "benchmark"] as const) {
        if (p[k]) next[k] = p[k];
        else if (labels[k]) empty.push(labels[k]);
      }
      if (!adopt && p.direction) next.direction = p.direction;
      let autoStop = false;
      if (!next.stop) {
        // No stop on the card: suggest one 20% from the current price (editable).
        const q = await fetch(`/api/stocks/quote?symbol=${encodeURIComponent(p.ticker)}`, { cache: "no-store" })
          .then((x) => x.json() as Promise<{ quote?: StockQuote | null }>)
          .catch(() => null);
        const last = q?.quote?.last;
        if (last && last > 0) {
          next.stop = String(suggestedStop(last, next.direction === "long"));
          autoStop = true;
        }
      }
      const i = empty.indexOf("stop");
      if (autoStop && i >= 0) empty.splice(i, 1);
      setAutoStop(autoStop);
      setF(next);
      setRes(null);
      setCard({ cardId: p.cardId, cardUrl: p.cardUrl, entryHint: p.entryHint, empty });
    } catch {
      setCardErr("Couldn't reach the server");
    } finally {
      setCardBusy(false);
    }
  }
  const cardBox = (
    <div className="space-y-1 rounded-lg bg-surface-2 p-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-2">
          Trend Scout card #
          <input
            className={`${inputCls} w-28`}
            inputMode="numeric"
            value={cardNo}
            onChange={(e) => setCardNo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && cardNo.trim() && loadCard()}
            placeholder="246"
          />
        </label>
        <button className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-40" disabled={cardBusy || !cardNo.trim()} onClick={loadCard}>
          {cardBusy ? "Loading…" : card ? "Reload" : "Load card"}
        </button>
        {card && (
          <span className="pb-2 text-xs text-ink-2">
            Card {card.cardId} loaded{" "}
            {card.cardUrl && (
              <a className="text-accent underline" href={card.cardUrl} target="_blank" rel="noreferrer">
                open card
              </a>
            )}
          </span>
        )}
      </div>
      {cardErr && <div className="text-xs text-loss">{cardErr}</div>}
      {card && card.empty.length > 0 && <div className="text-xs text-warn">Not on the card, fill in: {card.empty.join(", ")}</div>}
      {card?.entryHint && !adopt && <div className="text-xs text-muted">Card&apos;s entry price: {card.entryHint} (choose Limit to use it)</div>}
      {!card && <div className="text-xs text-muted">{adopt ? "Optional: load this position's card to fill in the fields." : "The card sets the ticker and fills in the form; you can adjust everything except the ticker."}</div>}
    </div>
  );
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const lateLong = f.stage === "3" && f.direction === "long";
  // What's still missing, with the same minimum lengths the server enforces.
  const len = (v: string, n: number) => v.trim().length >= n;
  const missing = [
    !f.ticker && "Ticker",
    !f.stop && "Stop",
    f.entryType !== "market" && !f.limitPrice && (f.entryType === "stop" ? "Entry price" : "Limit price"),
    !f.days && "Time frame (days)",
    !f.source && "Source",
    !len(f.thesis, 10) && "Thesis (10+ characters)",
    f.stage === "" && "Stage",
    lateLong && !f.lateStageAck && '"I understand" (late stage)',
    !len(f.becauseData, 5) && "Because of this data… (5+ characters)",
    !len(f.catalyst, 5) && "Catalyst (5+ characters)",
    !len(f.invalidation, 5) && "What proves it wrong (5+ characters)",
    f.planAdd && !len(f.addTrigger, 5) && "Add trigger (5+ characters)",
  ].filter((x): x is string => !!x);
  const complete = missing.length === 0;
  const payload = () => ({
    ...f,
    cardId: card?.cardId ?? null,
    limitPrice: f.entryType !== "market" ? Number(f.limitPrice) : null,
    stop: Number(f.stop),
    target: f.target ? Number(f.target) : null,
    days: Number(f.days),
    stage: f.stage === "" ? null : Number(f.stage),
    crowding: f.crowding || null,
    addTrigger: f.planAdd ? f.addTrigger : null,
  });
  const key = JSON.stringify(f);
  // Step 1: check and size (nothing logged or sent). Step 2: confirm — the server re-runs every check.
  async function check() {
    setBusy(true);
    setRes(null);
    const { json } = await post(endpoint, { ...payload(), preview: true });
    setRes(json as Res);
    setPreviewed(json.ok ? key : null);
    setBusy(false);
  }
  async function submit() {
    setBusy(true);
    const { json } = await post(endpoint, payload());
    setRes(json as Res);
    setPreviewed(null);
    setBusy(false);
    if (json.ok) {
      setF(blank);
      setCard(null);
      setCardNo("");
    }
    onDone();
  }
  if (!adopt && !card)
    return (
      <section className="card space-y-3 p-4">
        <h2 className="font-bold text-accent">New idea</h2>
        {cardBox}
        {res && !res.preview && res.ok && <div className="text-sm text-gain">{dry ? "Dry run logged (nothing sent)" : "Order sent"}</div>}
      </section>
    );
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold text-accent">{adopt ? `Manage ${adopt.symbol} (opened outside the app)` : "New idea"}</h2>
        {onCancel && (
          <button className="text-xs text-muted underline" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {adopt && (
        <p className="rounded-lg bg-surface-2 p-2 text-xs text-ink-2">
          Schwab position: <b>{Math.abs(adopt.qty)}</b> sh {adopt.qty > 0 ? "long" : "short"} @ <b>{adopt.avgPrice}</b>. Fill in the rest; on confirm the server places a
          real stop{f.target ? " and target" : ""} for these shares at Schwab and manages it from then on. Cancel any stop you set in the Schwab app first, or both
          could fill. Guardrails it already broke are logged as overrides.
        </p>
      )}
      {cardBox}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-xs text-ink-2">
          Ticker{card ? " (from the card)" : ""}
          <input className={inputCls} value={f.ticker} disabled onChange={(e) => setF({ ...f, ticker: e.target.value.toUpperCase() })} placeholder="AAPL" />
        </label>
        <label className="text-xs text-ink-2">
          Direction
          <select className={inputCls} value={f.direction} disabled={!!adopt} onChange={set("direction")}>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <QuoteLine q={quote} stop={Number(f.stop)} target={Number(f.target)} limit={f.entryType !== "market" ? Number(f.limitPrice) : 0} long={f.direction === "long"} />
        {chartTrade && (
          <div className="col-span-2 md:col-span-4">
            <StockTradeChart trade={chartTrade} live />
          </div>
        )}
        {!adopt && (
          <>
            <label className="text-xs text-ink-2">
              Entry
              <select className={inputCls} value={f.entryType} onChange={set("entryType")}>
                <option value="market">Market</option>
                <option value="limit">Limit</option>
                <option value="stop">Stop (enter on a move through a price)</option>
              </select>
            </label>
            <label className="text-xs text-ink-2">
              {f.entryType === "stop" ? `Enter if price goes ${f.direction === "long" ? "above" : "below"}` : "Limit price"}
              <input className={inputCls} inputMode="decimal" disabled={f.entryType === "market"} value={f.limitPrice} onChange={set("limitPrice")} />
            </label>
          </>
        )}
        <label className="text-xs text-ink-2">
          Stop{autoStop && f.stop ? ` (auto ${SUGGESTED_STOP_PCT}%)` : ""}
          <input
            className={inputCls}
            inputMode="decimal"
            value={f.stop}
            onChange={(e) => {
              setAutoStop(false);
              setF({ ...f, stop: e.target.value });
            }}
          />
          {stop20 && f.stop !== stop20 && (
            <button
              type="button"
              className="mt-1 text-accent underline"
              onClick={() => {
                setAutoStop(true);
                setF({ ...f, stop: stop20 });
              }}
            >
              Use {SUGGESTED_STOP_PCT}% stop: {stop20}
            </button>
          )}
        </label>
        <label className="text-xs text-ink-2">
          Target (optional)
          <input className={inputCls} inputMode="decimal" value={f.target} onChange={set("target")} />
        </label>
        <label className="text-xs text-ink-2">
          Time frame (days)
          <input className={inputCls} inputMode="numeric" value={f.days} onChange={set("days")} />
        </label>
        <label className="text-xs text-ink-2">
          Source
          <select className={inputCls} value={f.source} disabled={!!card} onChange={set("source")}>
            <option value="">Choose…</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs text-ink-2">
        Benchmark ETF (optional, e.g. XBI, SMH, XLE — scored against it as well as SPY)
        <input className={inputCls} value={f.benchmark} onChange={(e) => setF({ ...f, benchmark: e.target.value.toUpperCase() })} placeholder="SPY is always used" />
      </label>
      <label className="block text-xs text-ink-2">
        Thesis (1–3 sentences)
        <textarea className={inputCls} rows={2} value={f.thesis} onChange={set("thesis")} />
      </label>
      <label className="block text-xs text-ink-2">
        Stage
        <select className={inputCls} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value, lateStageAck: false })}>
          <option value="">Choose…</option>
          {STAGES.map((st) => (
            <option key={st.value} value={st.value}>
              {st.label}: {st.hint}
            </option>
          ))}
        </select>
      </label>
      {lateLong && (
        <label className="flex items-center gap-2 rounded-lg border border-warn/60 bg-warn/10 p-2 text-sm text-warn">
          <input type="checkbox" checked={f.lateStageAck} onChange={(e) => setF({ ...f, lateStageAck: e.target.checked })} />
          Late stage: crowd is in. I understand.
        </label>
      )}
      <div className="grid gap-2">
        <label className="text-xs text-ink-2">
          Because of this data…
          <textarea className={inputCls} rows={2} value={f.becauseData} onChange={set("becauseData")} />
        </label>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-xs text-muted md:col-span-2">
          Catalyst (what forces the market to see it)
          <input className={inputCls} value={f.catalyst} onChange={set("catalyst")} placeholder="Q4 earnings, product launch, FDA decision…" />
        </label>
        <label className="text-xs text-ink-2">
          Catalyst date or window (optional)
          <input className={inputCls} value={f.catalystDate} onChange={set("catalystDate")} placeholder="Feb 12 / mid-March" />
        </label>
      </div>
      <label className="block text-xs text-ink-2">
        What proves it wrong (thesis kill criteria, separate from the stop)
        <textarea className={inputCls} rows={2} value={f.invalidation} onChange={set("invalidation")} />
      </label>
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-xs text-muted md:col-span-2">
          What the price implies (optional)
          <input className={inputCls} value={f.priceImplies} onChange={set("priceImplies")} placeholder="priced for 10% growth" />
        </label>
        <label className="text-xs text-ink-2">
          Crowding at entry (optional)
          <select className={inputCls} value={f.crowding} onChange={set("crowding")}>
            <option value="">—</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <label className="block text-xs text-ink-2">
        Notes (optional)
        <textarea className={inputCls} rows={2} value={f.ideaNotes} onChange={set("ideaNotes")} />
      </label>
      <div className={`space-y-2 rounded-lg bg-surface-2 p-2 ${adopt ? "hidden" : ""}`}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.planAdd} onChange={(e) => setF({ ...f, planAdd: e.target.checked })} />
          Plan one add (starter = 1/3 of full shadow size, add = the other 2/3)
        </label>
        {f.planAdd && (
          <label className="block text-xs text-ink-2">
            Add trigger (decided now)
            <input className={inputCls} value={f.addTrigger} onChange={set("addTrigger")} placeholder="guidance raise at next earnings / close above $X after earnings" />
          </label>
        )}
      </div>
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
          {adopt ? "Confirm & place stop" : dry ? "Confirm dry run" : "Confirm & send order"}
        </button>
        {missing.length > 0 && <span className="w-full text-xs text-warn">Still needed: {missing.join(" · ")}</span>}
        <span className="text-xs text-muted">
          Size is fixed in Settings. Every check runs on the server. Outside 9:30–16:00 ET use a limit (extended hours); the stop only
          works in the regular session.
        </span>
      </div>
      {res && (
        <div className={`rounded-xl border p-3 text-sm ${res.ok ? "border-gain/40" : "border-loss/40"}`}>
          <div className={`font-semibold ${res.ok ? "text-gain" : "text-loss"}`}>
            {res.preview
              ? res.ok
                ? adopt
                  ? "Ready — review, then confirm to place the stop"
                  : "All checks pass — review the size, then confirm"
                : "Blocked"
              : res.ok
                ? adopt
                  ? "Adopted — stop placed at Schwab"
                  : dry
                    ? "Dry run logged (nothing sent)"
                    : "Order sent"
                : "Blocked"}
          </div>
          {res.sizing && (
            <div className="my-2 grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg bg-surface-2 p-2 text-xs sm:grid-cols-3">
              <span>
                {adopt ? "Position (from Schwab)" : dry ? "Order (dry run, not sent)" : "Order to Schwab"}: <b>{res.sizing.liveShares}</b> share{res.sizing.liveShares === 1 ? "" : "s"}
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
              {res.sizing.planAdd && (
                <span className="col-span-full text-ink-2">
                  Planned add: starter <b>{res.sizing.starterShadow}</b> shadow sh now ({money(res.sizing.starterPosition ?? 0)}, risk {money(res.sizing.starterRisk ?? 0)}), add{" "}
                  <b>{res.sizing.addShadow}</b> sh when the trigger is met · live 1 + 1 share
                </span>
              )}
            </div>
          )}
          {res.error && <div className="text-loss">{res.error}</div>}
          {!!res.overrides?.length && (
            <div className="text-warn">
              Recorded as overrides (stops the size-up banner): {res.overrides.join("; ")}
            </div>
          )}
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
  const [addStop, setAddStop] = useState("");
  const [addNote, setAddNote] = useState("");
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
            · {t.shares} sh · {t.status} · {t.source}
            {t.cardId && (
              <>
                {" "}
                <a className="text-accent underline" href={t.cardUrl ?? "#"} target="_blank" rel="noreferrer">
                  card {t.cardId}
                </a>
              </>
            )}{" "}
            · exit by {t.exitBy}
            {t.mode === "dry" ? " · DRY RUN" : ""}
          </span>
        </div>
        <div className={`font-semibold ${plClass(pl ?? 0)}`}>
          {pl === null ? "—" : money(pl, { sign: true, cents: true })} {r !== null && <span className="text-xs">({r.toFixed(2)}R)</span>}
        </div>
      </div>
      <div className="mt-1 text-xs text-ink-2">
        entry {entry ?? (t.entryType !== "market" ? `${t.entryType} ${t.limitPrice} (working)` : "pending")} · last {r2(last)} · stop {t.stop} · target {t.target ?? "—"} · risk/sh {t.riskPerShare} · shadow{" "}
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
      {t.planAdd && (
        <div className="mt-2 space-y-1 rounded-lg border border-border p-2 text-xs">
          <div>
            <b>Planned add</b> · trigger: {t.addTrigger}
            {t.add ? (
              <span className="ml-1 text-ink-2">
                · {t.add.status} {t.add.price ? `at ${t.add.price}` : ""} · +{t.add.shadowShares} shadow sh · &quot;{t.add.note}&quot;
              </span>
            ) : (
              <span className="ml-1 text-muted">· not used (only in profit; move the stop so starter + add risk ≤ {t.shadowRiskPct}%)</span>
            )}
          </div>
          {!t.add && t.status === "open" && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputCls} w-24`} inputMode="decimal" placeholder="new stop" value={addStop} onChange={(e) => setAddStop(e.target.value)} />
              <input className={`${inputCls} min-w-40 flex-1`} placeholder="what happened (one line)" value={addNote} onChange={(e) => setAddNote(e.target.value)} />
              <button
                className="rounded-lg bg-accent px-2 py-1 font-semibold text-page disabled:opacity-40"
                disabled={!addStop || !addNote.trim()}
                onClick={async () => {
                  setMsg(null);
                  const { json } = await post("/api/stocks/trade", { id: t.id, action: "add", value: Number(addStop), note: addNote });
                  setMsg(json.ok ? "Add sent" : `${json.error ?? "Blocked"}${json.requiredStop ? ` (stop needed: ${json.requiredStop})` : ""}`);
                  onDone();
                }}
              >
                Trigger met
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PM_OPTS = {
  thesisRight: ["yes", "no", "partly"],
  catalystHappened: ["yes", "no", "not yet"],
  rightReason: ["yes", "no", "luck"],
} as const;

/** Post-mortem for a closed trade (more than 2 left open for 3 trading days blocks new entries). */
function PostMortemForm({ t, onDone }: { t: Trade; onDone: () => void }) {
  const [v, setV] = useState({ thesisRight: "", catalystHappened: "", rightReason: "", learned: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const sel = (k: keyof typeof PM_OPTS, label: string) => (
    <label className="text-xs text-ink-2">
      {label}
      <select className={inputCls} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })}>
        <option value="">—</option>
        {PM_OPTS[k].map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
      <div>
        <b>{t.ticker}</b> {t.direction} · {t.exitReason} · {t.r ?? "—"}R · closed {t.exitTime ? formatDateTimeET(t.exitTime) : ""}
        <div className="text-xs text-muted">Thesis: {t.thesis}</div>
        {t.catalyst && (
          <div className="text-xs text-muted">
            Catalyst: {t.catalyst}{t.catalystDate ? ` (${t.catalystDate})` : ""}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {sel("thesisRight", "Was the thesis right?")}
        {sel("catalystHappened", "Did the catalyst happen?")}
        {sel("rightReason", "Did it work for the reason you gave?")}
      </div>
      <input className={inputCls} placeholder="One line on what you learned" value={v.learned} onChange={(e) => setV({ ...v, learned: e.target.value })} />
      <div className="flex items-center gap-2">
        <button
          className="rounded-lg bg-accent px-3 py-1 font-semibold text-page disabled:opacity-40"
          disabled={!v.thesisRight || !v.catalystHappened || !v.rightReason || !v.learned.trim()}
          onClick={async () => {
            const { json } = await post("/api/stocks/trade", { id: t.id, action: "postmortem", postMortem: v });
            setMsg(json.ok ? "Saved" : String(json.error ?? "Failed"));
            onDone();
          }}
        >
          Save post-mortem
        </button>
        {msg && <span className="text-xs">{msg}</span>}
      </div>
    </div>
  );
}

export default function StocksPage() {
  const { data, error, refresh } = usePoll<StocksData>("/api/stocks");
  const [busy, setBusy] = useState(false);
  const [flatMsg, setFlatMsg] = useState<string | null>(null);
  const [shownChart, setShownChart] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<Held | null>(null);
  if (!data) return <div className="text-sm text-muted">{error ?? "Loading…"}</div>;
  const dry = data.mode === "dry";
  // Every open trade, dry and live (an adopted position is live even while new ideas are dry runs).
  const open = data.trades.filter((t) => ["pending", "open", "closing"].includes(t.status));
  const closed = data.trades.filter((t) => t.status === "closed" || t.status === "cancelled");
  const s = data.summary;
  const chartTrade = closed.find((t) => t.id === shownChart) ?? null;
  const needPm = data.trades.filter((t) => t.mode === data.mode && t.status === "closed" && !t.postMortem);
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
            ["By stage at entry", s.byStage],
            ["By crowding at entry", s.byCrowding],
            ["By planned add", s.byAdd],
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
        <div className="text-sm">
          <span className="font-semibold text-ink-2">Worked for the stated reason (post-mortems): </span>
          {s.reasons.filled ? (
            <>
              yes {Math.round((s.reasons.yes / s.reasons.filled) * 100)}% · luck {Math.round((s.reasons.luck / s.reasons.filled) * 100)}% · no{" "}
              {Math.round((s.reasons.no / s.reasons.filled) * 100)}% <span className="text-muted">({s.reasons.filled} filled in)</span>
            </>
          ) : (
            <span className="text-muted">no post-mortems yet</span>
          )}
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

      {needPm.length > 0 && (
        <section className="card space-y-2 border-warn/50 p-4">
          <h2 className="font-bold text-warn">Post-mortem ({needPm.length})</h2>
          <p className="text-xs text-muted">More than 2 trades left without one for 3 trading days blocks new entries.</p>
          {needPm.map((t) => (
            <PostMortemForm key={t.id} t={t} onDone={refresh} />
          ))}
        </section>
      )}

      {data.unmanaged.length > 0 && (
        <section className="card space-y-2 p-4">
          <h2 className="font-bold text-accent">At Schwab, not managed here ({data.unmanaged.length})</h2>
          <p className="text-xs text-muted">
            Stock positions in account ••{data.account?.last4} this tab doesn&apos;t manage, e.g. bought in the Schwab app while the API was down. Adopt one to have its stop
            and target managed here.
          </p>
          {data.unmanaged.map((h) => (
            <div key={h.symbol} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-2 text-sm">
              <span>
                <b>{h.symbol}</b> {h.qty > 0 ? "long" : "short"} {Math.abs(h.qty)} sh @ {h.avgPrice} <span className="text-xs text-muted">{h.description}</span>
              </span>
              <button className="rounded-lg border border-accent px-3 py-1 text-xs font-semibold text-accent" onClick={() => setAdopting(h)}>
                Manage this position
              </button>
            </div>
          ))}
        </section>
      )}
      {adopting && <IdeaForm key={adopting.symbol} dry={dry} adopt={adopting} onCancel={() => setAdopting(null)} onDone={refresh} />}

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
                <td>{t.cardId ? `card ${t.cardId}` : t.source}</td>
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
        week · weekly shadow-loss lockout {data.settings.weeklyLossPct}% · entries any time (limit only outside 9:30–16:00 ET). Change them in Settings (loosening waits
        24 hours).
      </p>
    </div>
  );
}
