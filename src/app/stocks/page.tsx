"use client";

import { useEffect, useMemo, useState } from "react";
import type { StocksData } from "@/app/api/stocks/route";
import { money, plClass } from "@/components/format";
import { StockEquity } from "@/components/StockEquity";
import { StockPnlChart } from "@/components/StockPnlChart";
import { StockPortfolio } from "@/components/StockPortfolio";
import { StockTradeChart, type ChartTrade, type HeldMark } from "@/components/StockTradeChart";
import { usePoll } from "@/components/usePoll";
import { usePref } from "@/components/usePref";
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

/** Quote for the ticker being typed: fetched 400 ms after typing stops, then refreshed every 15 s. */
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
    const every = setInterval(load, 15_000);
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

/** Collapse / expand a section; the choice is remembered in this browser. */
function useCollapsed(id: string): [boolean, React.ReactNode] {
  const [c, setC] = usePref<boolean>(`stocks.collapsed.${id}`, false, (v) => typeof v === "boolean");
  return [
    c,
    <button
      key="collapse"
      type="button"
      onClick={() => setC(!c)}
      aria-expanded={!c}
      title={c ? "Expand" : "Collapse"}
      className="ml-2 rounded-md border border-border px-2 py-0.5 align-middle text-xs font-normal text-ink-2"
    >
      {c ? "▸ Show" : "▾ Hide"}
    </button>,
  ];
}
/** Hides everything in a section but its first child (the heading row). */
const collapsedCls = (c: boolean) => (c ? " [&>*:not(:first-child)]:hidden" : "");

interface Held {
  symbol: string;
  description: string;
  qty: number;
  avgPrice: number;
}

/** New idea — or, with `adopt`, the same form for a position already opened outside the app. */
function IdeaForm({ onDone, dry, adopt, onCancel, maxPositionPct, openTrades = [], unmanaged = [] }: { onDone: () => void; dry: boolean; adopt?: Held; onCancel?: () => void; maxPositionPct: number; openTrades?: Trade[]; unmanaged?: Held[] }) {
  // Confidence slider: this trade's position cap, from 0.5% (or the max, if lower) up to the max-position setting.
  const [posPct, setPosPct] = useState<number | null>(null);
  const posMin = Math.min(0.5, maxPositionPct);
  const pos = Math.min(posPct ?? maxPositionPct, maxPositionPct);
  const blank = {
    ticker: "",
    direction: "long",
    entryType: "market",
    limitPrice: "",
    stop: "",
    target: "",
    thesis: "",
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
      byRisk?: boolean;
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
  // What is already on in this ticker: an open or pending idea here, or shares at Schwab the tab doesn't manage.
  const mine = adopt ? null : (openTrades.find((t) => t.ticker === f.ticker) ?? null);
  const atSchwab = adopt || mine ? null : (unmanaged.find((h) => h.symbol === f.ticker) ?? null);
  const mineKey = mine ? [mine.id, mine.status, mine.entryPrice, mine.limitPrice, mine.stop, mine.target, mine.shares, mine.shadowShares].join("|") : atSchwab ? `${atSchwab.symbol}|${atSchwab.qty}|${atSchwab.avgPrice}` : "";
  const heldMark = useMemo<HeldMark | null>(() => {
    if (mine) {
      const sh = (mine.mode === "dry" ? mine.shadowShares : mine.shares).toLocaleString("en-US");
      const px = mine.entryPrice ?? mine.limitPrice ?? null;
      if (!px) return null;
      return { long: mine.direction === "long", entry: px, stop: mine.stop, target: mine.target, time: mine.entryTime, label: mine.status === "pending" ? `your pending ${mine.direction} entry` : `your ${mine.direction} ${sh} sh` };
    }
    if (atSchwab) return { long: atSchwab.qty > 0, entry: atSchwab.avgPrice, stop: 0, label: `at Schwab: ${atSchwab.qty > 0 ? "long" : "short"} ${Math.abs(atSchwab.qty)} sh` };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mineKey covers every field read from mine / atSchwab
  }, [mineKey]);
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
        stop: "stop", thesis: "thesis", stage: "stage",
        becauseData: "because of this data", catalyst: "catalyst", invalidation: "what proves it wrong",
      };
      const empty: string[] = [];
      for (const k of ["stop", "target", "thesis", "invalidation", "ideaNotes", "becauseData", "catalyst", "catalystDate", "priceImplies", "stage", "crowding", "benchmark"] as const) {
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
    positionPct: adopt ? null : pos,
    limitPrice: f.entryType !== "market" ? Number(f.limitPrice) : null,
    stop: Number(f.stop),
    target: f.target ? Number(f.target) : null,
    stage: f.stage === "" ? null : Number(f.stage),
    crowding: f.crowding || null,
    addTrigger: f.planAdd ? f.addTrigger : null,
  });
  const key = JSON.stringify([f, pos]);
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
            {mine && (
              <div className="mb-1 rounded-lg border border-warn/60 bg-warn/10 p-2 text-xs text-warn">
                You already have {mine.status === "pending" ? "a pending entry" : "a position"} in {mine.ticker}: <b>{mine.direction}</b>{" "}
                {(mine.mode === "dry" ? mine.shadowShares : mine.shares).toLocaleString("en-US")} sh
                {mine.entryPrice ? ` @ ${mine.entryPrice}` : mine.limitPrice ? ` (${mine.entryType} ${mine.limitPrice}, not filled)` : ""} · stop {mine.stop}
                {mine.target ? ` · target ${mine.target}` : ""}
                {mine.entryPrice && quote?.q?.last
                  ? ` · open P/L ${(((quote.q.last - mine.entryPrice) / mine.entryPrice) * 100 * (mine.direction === "long" ? 1 : -1)).toFixed(2)}%`
                  : ""}
                {mine.mode === "dry" ? " · dry run" : ""}. It&apos;s drawn on the chart in yellow. A second idea in the same ticker is blocked (one position per ticker).
              </div>
            )}
            {atSchwab && (
              <div className="mb-1 rounded-lg border border-warn/60 bg-warn/10 p-2 text-xs text-warn">
                You hold {atSchwab.symbol} at Schwab outside this tab: {atSchwab.qty > 0 ? "long" : "short"} {Math.abs(atSchwab.qty)} sh @ {atSchwab.avgPrice} (drawn in yellow). Use
                &quot;Manage this position&quot; above to bring it in.
              </div>
            )}
            <StockTradeChart trade={chartTrade} live last={quote?.q?.last ?? null} held={heldMark} />
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
      {!adopt && maxPositionPct > posMin && (
        <label className="block rounded-lg bg-surface-2 p-2 text-xs text-ink-2">
          Position size by confidence: up to <b className="text-sm text-ink">{pos}%</b> of the account
          <input type="range" className="mt-1 block w-full accent-[var(--accent)]" min={posMin} max={maxPositionPct} step={0.25} value={pos} onChange={(e) => setPosPct(Number(e.target.value))} />
          <span className="flex justify-between text-muted">
            <span>{posMin}%</span>
            <span>The {"risk per trade"} limit still applies: a wide stop can make the size smaller than this.</span>
            <span>{maxPositionPct}% (max in Settings)</span>
          </span>
        </label>
      )}
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
                {res.sizing.byRisk ? " (sized from the account)" : ""}
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
                <li key={c.name} className={!c.ok ? "text-loss" : c.detail.startsWith("Warning") ? "text-warn" : "text-ink-2"}>
                  {!c.ok ? "✗" : c.detail.startsWith("Warning") ? "!" : "✓"} <span className="font-medium">{c.name}</span> — {c.detail}
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
  // The stock's own move from the entry price to the last price (negative is good for a short).
  const move = entry !== null && last !== null && entry > 0 ? ((last - entry) / entry) * 100 : null;
  const act = async (action: string, value?: number) => {
    setMsg(null);
    const { json } = await post("/api/stocks/trade", { id: t.id, action, value });
    setMsg(json.ok ? "Done" : String(json.error ?? "Failed"));
    onDone();
  };
  return (
    <div id={`trade-${t.id}`} className="scroll-mt-4 rounded-xl bg-surface-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-bold">{t.ticker}</span> <span className={t.direction === "long" ? "text-gain" : "text-loss"}>{t.direction}</span>{" "}
          <span className="text-muted">
            · {t.shares} sh · {t.status} · {t.source}
            {" "}
            {t.cardId ? (
              <a className="text-accent underline" href={t.cardUrl ?? "#"} target="_blank" rel="noreferrer">
                card {t.cardId}
              </a>
            ) : (
              <button
                type="button"
                className="text-accent underline"
                onClick={async () => {
                  const n = prompt(`Trend Scout card number for ${t.ticker}?`);
                  if (!n) return;
                  const { json } = await post("/api/stocks/trade", { id: t.id, action: "card", value: n.trim().replace(/^#/, "") });
                  setMsg(json.ok ? "Card linked" : String(json.error ?? "Failed"));
                  onDone();
                }}
              >
                add card #
              </button>
            )}{" "}
            {t.exitBy ? `· exit by ${t.exitBy}` : ""}
            {t.mode === "dry" ? " · DRY RUN" : ""}
          </span>
        </div>
        <div className={`font-semibold ${plClass(pl ?? 0)}`}>
          {pl === null ? "—" : money(pl, { sign: true, cents: true })}{" "}
          {move !== null && (
            <span className="text-xs">
              ({move * dir >= 0 ? "+" : ""}
              {(move * dir).toFixed(2)}%{r !== null ? ` · ${r.toFixed(2)}R` : ""})
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 text-xs text-ink-2">
        entry {entry ?? (t.entryType !== "market" ? `${t.entryType} ${t.limitPrice} (working)` : "pending")} · last {r2(last)}
        {move !== null && (
          <span className={plClass(move * dir)}>
            {" "}
            ({move >= 0 ? "+" : ""}
            {move.toFixed(2)}% since entry)
          </span>
        )}{" "}
        · stop {t.stop} · target {t.target ?? "—"} · risk/sh {t.riskPerShare} · shadow{" "}
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
      <StockTradeChart trade={t} last={last} />
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

interface WorkingOrder {
  key: string;
  ticker: string;
  kind: string;
  side: string;
  shares: number;
  price: string;
  last: number | null;
  tif: string;
  dry: boolean;
  id: string | null;
  note?: string;
}

/** Every order that is working right now, read off the trades: unfilled entries, protective stops, targets. */
function workingOrders(trades: Trade[], quotes: Record<string, number | null>): WorkingOrder[] {
  const out: WorkingOrder[] = [];
  for (const t of trades) {
    const long = t.direction === "long";
    const open = long ? "Buy" : "Sell short";
    const close = long ? "Sell" : "Buy to cover";
    const base = { ticker: t.ticker, last: quotes[t.ticker] ?? null, dry: t.mode === "dry" };
    const id = (v: string | null | undefined) => (v && !v.startsWith("dry-") ? v : null);
    if (t.status === "pending") {
      const kind = t.entryType === "stop" ? "Entry stop" : t.entryType === "limit" ? "Entry limit" : "Entry market";
      out.push({ ...base, key: `${t.id}-e`, kind, side: open, shares: t.shares, price: t.entryType === "market" ? "market" : String(t.limitPrice), tif: t.entryType === "market" ? "Day" : "GTC", id: id(t.orderId) });
      // The stop and target are attached to the entry and start working once it fills.
      out.push({ ...base, key: `${t.id}-s`, kind: "Stop", side: close, shares: t.shares, price: String(t.stop), tif: "GTC", id: id(t.stopOrderId), note: "after entry fills" });
      if (t.target) out.push({ ...base, key: `${t.id}-t`, kind: "Target", side: close, shares: t.shares, price: String(t.target), tif: "GTC", id: id(t.targetOrderId), note: "after entry fills" });
    } else if (t.status === "open") {
      out.push({ ...base, key: `${t.id}-s`, kind: "Stop", side: close, shares: t.shares, price: String(t.stop), tif: "GTC", id: id(t.stopOrderId) });
      if (t.target) out.push({ ...base, key: `${t.id}-t`, kind: "Target", side: close, shares: t.shares, price: String(t.target), tif: "GTC", id: id(t.targetOrderId) });
      if (t.add?.status === "pending") out.push({ ...base, key: `${t.id}-a`, kind: "Add (market)", side: open, shares: t.add.liveShares, price: "market", tif: "Day", id: id(t.add.orderId) });
      if (t.add?.status === "filled") {
        out.push({ ...base, key: `${t.id}-as`, kind: "Stop (add)", side: close, shares: t.add.liveShares, price: String(t.stop), tif: "GTC", id: id(t.add.stopOrderId) });
        if (t.target) out.push({ ...base, key: `${t.id}-at`, kind: "Target (add)", side: close, shares: t.add.liveShares, price: String(t.target), tif: "GTC", id: id(t.add.targetOrderId) });
      }
    } else if (t.status === "closing") {
      out.push({ ...base, key: `${t.id}-x`, kind: "Close (market)", side: close, shares: t.shares + (t.add?.status === "filled" ? t.add.liveShares : 0), price: "market", tif: "Day", id: id(t.exitOrderId) });
    }
  }
  return out;
}

/**
 * Entry legs of a filled position (incl. a filled add). A dry-run position is counted at its shadow size
 * (what the account-based sizing would trade); a live one at the shares actually held.
 */
function positionLegs(t: Trade): { sh: number; px: number }[] {
  const dry = t.mode === "dry";
  return [
    { sh: dry ? t.shadowShares : t.shares, px: t.entryPrice! },
    ...(t.add?.status === "filled" && t.add.price ? [{ sh: dry ? t.add.shadowShares : t.add.liveShares, px: t.add.price }] : []),
  ];
}

/** One row per filled open position, with its unrealized P/L on the actual shares (incl. a filled add). */
function OpenPositions({ trades, quotes, accountValue, now, maxPositionPct, onDone }: { trades: Trade[]; quotes: Record<string, number | null>; accountValue: number | null; now: number; maxPositionPct: number; onDone: () => void }) {
  const [trimMsg, setTrimMsg] = useState<string | null>(null);
  const trim = async () => {
    if (!confirm(`Resize every dry-run position to ${maxPositionPct}% of the account? Bigger ones are cut and smaller ones are raised. Raising a wide-stop trade can make its stop-out risk more than your risk-per-trade setting. Paper only: nothing is sent to Schwab.`)) return;
    const { json } = await post("/api/stocks/trim", {});
    const t = (json.trimmed as string[] | undefined) ?? [];
    setTrimMsg(json.ok ? (t.length ? `Resized: ${t.join(", ")}` : "Every position is already at the limit") : String(json.error ?? "Failed"));
    onDone();
  };
  type Key = "ticker" | "side" | "shares" | "avg" | "last" | "pl" | "pct" | "acct" | "r" | "days" | "stop" | "target";
  const [sort, setSort] = usePref<{ key: Key; desc: boolean }>("stocks.positions.sort", { key: "days", desc: false }, (v) => !!v && typeof v === "object" && "key" in v && "desc" in v);
  const [posC, posBtn] = useCollapsed("positions");
  const rows = trades
    .filter((t) => (t.status === "open" || t.status === "closing") && t.entryPrice != null)
    .map((t) => {
      const last = quotes[t.ticker] ?? null;
      const dir = t.direction === "long" ? 1 : -1;
      const legs = positionLegs(t);
      const shares = legs.reduce((a, l) => a + l.sh, 0);
      const cost = legs.reduce((a, l) => a + l.sh * l.px, 0);
      const pl = last === null ? null : legs.reduce((a, l) => a + (last - l.px) * dir * l.sh, 0);
      const r = last !== null && t.riskPerShare ? ((last - t.entryPrice!) * dir) / t.riskPerShare : null;
      // Share of the account: the position's current market value (its cost when there's no quote).
      const value = last === null ? cost : shares * last;
      return {
        t,
        last,
        shares,
        cost,
        value,
        avg: shares ? cost / shares : 0,
        pl,
        pct: pl === null || !cost ? null : (pl / cost) * 100,
        acct: accountValue ? (value / accountValue) * 100 : null,
        r,
        days: t.entryTime ? Math.max(0, Math.floor((now - t.entryTime) / 86_400_000)) : null,
      };
    });
  if (!rows.length) return null;
  const val = (x: (typeof rows)[number], k: Key): string | number | null =>
    k === "ticker" ? x.t.ticker : k === "side" ? x.t.direction : k === "stop" ? x.t.stop : k === "target" ? (x.t.target ?? null) : x[k];
  const sorted = [...rows].sort((a, b) => {
    const [va, vb] = [val(a, sort.key), val(b, sort.key)];
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1; // blanks last
    const c = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
    return sort.desc ? -c : c;
  });
  const priced = rows.filter((x) => x.pl !== null);
  const totPl = priced.reduce((a, x) => a + x.pl!, 0);
  const totCost = priced.reduce((a, x) => a + x.cost, 0);
  const totValue = rows.reduce((a, x) => a + x.value, 0);
  const dp = (v: number) => (v < 1 ? 4 : 2);
  const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const th = (k: Key, label: string) => (
    <th key={k}>
      <button
        className={`uppercase tracking-wide ${sort.key === k ? "text-ink" : ""}`}
        title="Sort"
        onClick={() => setSort({ key: k, desc: sort.key === k ? !sort.desc : !["ticker", "side", "days"].includes(k) })}
      >
        {label}
        {sort.key === k ? (sort.desc ? " ▼" : " ▲") : ""}
      </button>
    </th>
  );
  return (
    <section className={`card space-y-2 p-4${collapsedCls(posC)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold text-accent">
          Open positions ({rows.length}){posBtn}
        </h2>
        {rows.some((x) => x.t.mode === "dry" && x.acct !== null && Math.abs(x.acct - maxPositionPct) > 0.02) && (
          <button className="rounded-lg border border-accent px-3 py-1 text-xs font-semibold text-accent" onClick={() => void trim()}>
            Resize dry-run positions to {maxPositionPct}% of account
          </button>
        )}
      </div>
      {trimMsg && <div className="text-xs text-ink-2">{trimMsg}</div>}
      <div className="overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              {th("ticker", "Ticker")}
              {th("side", "Side")}
              {th("shares", "Shares")}
              {th("avg", "Entry")}
              {th("last", "Last")}
              {th("pl", "Open P/L")}
              {th("pct", "%")}
              {th("acct", "% of acct")}
              {th("r", "R")}
              {th("days", "Days")}
              {th("stop", "Stop")}
              {th("target", "Target")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ t, last, shares, avg, pl, pct: p, acct, r, days }) => (
              <tr key={t.id}>
                <td className="font-semibold">
                  <a
                    className="text-accent underline"
                    href={`#trade-${t.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(`trade-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    {t.ticker}
                  </a>
                </td>
                <td className={t.direction === "long" ? "text-gain" : "text-loss"}>{t.direction}</td>
                <td className="num">{shares.toLocaleString("en-US")}</td>
                <td className="num">{avg.toFixed(dp(avg))}</td>
                <td className="num">{last === null ? "—" : last.toFixed(dp(last))}</td>
                <td className={`num font-semibold ${plClass(pl ?? 0)}`}>{pl === null ? "—" : money(pl, { sign: true, cents: true })}</td>
                <td className={`num ${plClass(pl ?? 0)}`}>{pct(p)}</td>
                <td className="num">{acct === null ? "—" : `${acct.toFixed(2)}%`}</td>
                <td className={`num ${plClass(r ?? 0)}`}>{r === null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`}</td>
                <td className="num">{days ?? "—"}</td>
                <td className="num">{t.stop}</td>
                <td className="num">{t.target ?? "—"}</td>
                <td className="text-xs text-muted">{t.mode === "dry" ? "dry run (shadow size)" : t.status === "closing" ? "closing" : ""}</td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className="border-t border-border font-semibold">
                <td colSpan={5}>Total</td>
                <td className={`num ${plClass(totPl)}`}>{money(totPl, { sign: true, cents: true })}</td>
                <td className={`num ${plClass(totPl)}`}>{pct(totCost ? (totPl / totCost) * 100 : null)}</td>
                <td className="num">{accountValue ? `${((totValue / accountValue) * 100).toFixed(2)}%` : "—"}</td>
                <td colSpan={5}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PendingOrders({ orders }: { orders: WorkingOrder[] }) {
  const [c, btn] = useCollapsed("pending");
  return (
    <section className={`card space-y-2 p-4${collapsedCls(c)}`}>
      <h2 className="font-bold text-accent">
        Pending orders ({orders.length}){btn}
      </h2>
      {orders.length === 0 ? (
        <p className="text-sm text-muted">No working orders.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Order</th>
                <th>Side</th>
                <th>Shares</th>
                <th>Price</th>
                <th>Last</th>
                <th>Away</th>
                <th>Good for</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const px = Number(o.price);
                const away = o.last && px > 0 ? (((px - o.last) / o.last) * 100).toFixed(2) + "%" : "—";
                return (
                  <tr key={o.key}>
                    <td className="font-semibold">{o.ticker}</td>
                    <td className={o.kind.startsWith("Stop") ? "text-loss" : o.kind.startsWith("Target") ? "text-gain" : ""}>
                      {o.kind}
                      {o.note && <span className="text-xs text-muted"> ({o.note})</span>}
                    </td>
                    <td>{o.side}</td>
                    <td className="num">{o.shares}</td>
                    <td className="num">{o.price}</td>
                    <td className="num">{o.last ?? "—"}</td>
                    <td className="num">{away}</td>
                    <td>{o.tif}</td>
                    <td className="text-xs text-muted">{o.dry ? "dry run (not at Schwab)" : o.id ? `Schwab #${o.id}` : "Schwab (syncing)"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Floating "Top" button, shown once the page is scrolled down. */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 600);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  if (!show) return null;
  return (
    <button
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-20 right-4 z-40 rounded-full border border-accent bg-surface px-4 py-2 text-sm font-semibold text-accent shadow-lg md:bottom-6"
    >
      ↑ Top
    </button>
  );
}

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
  const [scoreC, scoreBtn] = useCollapsed("scorecard");
  const [ideasC, ideasBtn] = useCollapsed("ideas");
  const [closedC, closedBtn] = useCollapsed("closed");
  const [logC, logBtn] = useCollapsed("log");
  if (!data) return <div className="text-sm text-muted">{error ?? "Loading…"}</div>;
  const dry = data.mode === "dry";
  // Every open trade, dry and live (an adopted position is live even while new ideas are dry runs).
  const open = data.trades.filter((t) => ["pending", "open", "closing"].includes(t.status));
  const closed = data.trades.filter((t) => t.status === "closed" || t.status === "cancelled");
  // Total unrealized P/L of the filled positions (actual shares, incl. a filled add), and as a % of their cost.
  const openPl = open.reduce(
    (a, t) => {
      const last = data.quotes[t.ticker];
      if (t.entryPrice == null || last == null || (t.status !== "open" && t.status !== "closing")) return a;
      const dir = t.direction === "long" ? 1 : -1;
      const legs = positionLegs(t);
      for (const l of legs) {
        a.pl += (last - l.px) * dir * l.sh;
        a.cost += l.px * l.sh;
        if (dir > 0) a.long += l.px * l.sh;
        else a.short += l.px * l.sh;
      }
      a.n += 1;
      if (t.mode === "dry") a.dryN += 1;
      a.pct = a.cost > 0 ? (a.pl / a.cost) * 100 : 0;
      return a;
    },
    { pl: 0, cost: 0, long: 0, short: 0, pct: 0, n: 0, dryN: 0 },
  );
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
        <div>
          <div className="text-xs uppercase tracking-wide text-muted">Open P/L ({openPl.n} position{openPl.n === 1 ? "" : "s"})</div>
          <div className={`text-lg font-bold ${openPl.n ? plClass(openPl.pl) : "text-muted"}`}>
            {openPl.n ? (
              <>
                {money(openPl.pl, { sign: true, cents: true })}{" "}
                <span className="text-sm">
                  ({openPl.pct >= 0 ? "+" : ""}
                  {openPl.pct.toFixed(2)}% on the money invested)
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
          {openPl.n > 0 && (
            <div className="space-y-0.5 text-xs text-ink-2">
              <div>
                Invested: <b>{money(openPl.cost)}</b>
                {data.accountValue ? ` (${((openPl.cost / data.accountValue) * 100).toFixed(1)}% of the account)` : ""} · long {money(openPl.long)} · short {money(openPl.short)}
              </div>
              {data.accountValue && (
                <div>
                  Account {money(data.accountValue)} · open P/L is{" "}
                  <b className={plClass(openPl.pl)}>
                    {openPl.pl >= 0 ? "+" : ""}
                    {((openPl.pl / data.accountValue) * 100).toFixed(2)}%
                  </b>{" "}
                  of the account
                </div>
              )}
            </div>
          )}
          {openPl.dryN > 0 && <div className="text-xs text-muted">{openPl.dryN === openPl.n ? "dry-run positions, at shadow size" : `includes ${openPl.dryN} dry-run at shadow size`}</div>}
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

      <BackToTop />
      <OpenPositions trades={open} quotes={data.quotes} accountValue={data.accountValue} now={data.now} maxPositionPct={data.settings.maxPositionPct} onDone={refresh} />

      <StockPortfolio />
      <StockEquity trades={data.trades} mode={data.mode} />

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

      <section className={`card space-y-3 p-4${collapsedCls(scoreC)}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold text-accent">
            Scorecard {dry ? "(dry run)" : "(live)"}
            {scoreBtn}
          </h2>
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
      {adopting && <IdeaForm key={adopting.symbol} dry={dry} adopt={adopting} onCancel={() => setAdopting(null)} onDone={refresh} maxPositionPct={data.settings.maxPositionPct} />}

      <IdeaForm dry={dry} onDone={refresh} maxPositionPct={data.settings.maxPositionPct} openTrades={open} unmanaged={data.unmanaged} />

      <PendingOrders orders={workingOrders(open, data.quotes)} />

      <section className={`card space-y-2 p-4${collapsedCls(ideasC)}`}>
        <h2 className="font-bold text-accent">
          Open ideas ({open.length} of {data.settings.maxOpen}){ideasBtn}
          {(() => {
            const pend = open.filter((t) => t.status === "pending").length;
            return pend ? <span className="ml-2 text-sm font-normal text-muted">{open.length - pend} filled positions + {pend} entries not filled yet</span> : null;
          })()}
        </h2>
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

      <section className={`card space-y-2 overflow-x-auto p-4${collapsedCls(closedC)}`}>
        <h2 className="font-bold text-accent">Closed{closedBtn}</h2>
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

      <section className={`card space-y-2 p-4${collapsedCls(logC)}`}>
        <h2 className="font-bold text-accent">Order &amp; block log{logBtn}</h2>
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
        Guardrails ({data.mode}): {data.settings.sizeByRisk ? "orders sized from the account" : `${data.settings.shares} fixed share(s) per order`} · {data.settings.riskPct}% risk per trade, max {data.settings.maxPositionPct}% per position
        position · gross ≤ {data.settings.maxGrossPct}%, net ±{data.settings.maxNetPct}% · max {data.settings.maxOpen} open · {data.settings.maxPerWeek} new ideas per
        week · weekly shadow-loss lockout {data.settings.weeklyLossPct}% · entries any time (limit only outside 9:30–16:00 ET). Change them in Settings (loosening waits
        24 hours).
      </p>
    </div>
  );
}
