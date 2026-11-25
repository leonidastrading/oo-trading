"use client";

import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle, type AutoscaleInfo, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { usePref } from "@/components/usePref";
import type { Bar } from "@/lib/schwab/data";
import { regularSession, type Trade } from "@/lib/stocks/rules";
import { etOffsetMinutes, todayET } from "@/lib/time";

const css = (name: string, fallback: string) =>
  (typeof window !== "undefined" && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

/**
 * TradingView-style candles for one trade: entry (and exit) markers, and lines at the entry price, the
 * current stop and the target. Daily or 5-minute bars (the 5-minute axis reads New York time).
 */
export type ChartTrade = Pick<Trade, "ticker" | "direction" | "stop" | "initialStop"> &
  Partial<Pick<Trade, "entryPrice" | "limitPrice" | "target" | "exitPrice" | "entryType" | "entryTime" | "exitTime" | "pl" | "exitReason">>;

/** `live` re-reads the bars every 30 s (used on the entry form, before there is a trade). */
/** A position already held in this ticker, drawn on the entry form's chart. */
export interface HeldMark {
  long: boolean;
  entry: number;
  stop: number;
  target?: number | null;
  time?: number | null;
  label: string;
}

type Ohlc = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

/** `last` (the live quote) keeps the newest candle moving between bar refreshes. */
export function StockTradeChart({ trade, live, last, held }: { trade: ChartTrade; live?: boolean; last?: number | null; held?: HeldMark | null }) {
  const cur = useRef<{ update: (b: Ohlc) => void; lastBar: Ohlc; tf: "D" | "5m"; shift: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLSpanElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Load the bars only once the chart scrolls into view: a page with many open trades would otherwise
  // ask Schwab for every ticker at once and trip the request limit.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      void Promise.resolve().then(() => setSeen(true));
      return;
    }
    // It must stay on screen for a moment: a smooth scroll past 40 charts (a ticker link, "Top") loads none.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver((es) => {
      const on = es.some((e) => e.isIntersecting);
      if (on && !timer) timer = setTimeout(() => setSeen(true), 700);
      if (!on && timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [seen]);
  // Daily / 5 min is one choice for every stock chart, remembered across reloads.
  const [tf, setTf] = usePref<"D" | "5m">("stocks.chart.tf", "D", (v) => v === "D" || v === "5m");
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!seen) return;
    let off = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      fetch(`/api/stocks/bars?symbol=${encodeURIComponent(trade.ticker)}&tf=${tf}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { bars?: Bar[]; error?: string; busy?: boolean }) => {
          if (off) return;
          // The server holds chart requests back when Schwab's request budget is nearly used: try again shortly.
          if (j.busy && !j.bars?.length && tries++ < 6) {
            setErr("Waiting for a free data slot…");
            retry = setTimeout(load, 20_000);
            return;
          }
          setBars(j.bars ?? []);
          setErr(j.error ?? null);
        })
        .catch(() => !off && setErr("Couldn't load bars"));
    load();
    const every = live ? setInterval(load, 30_000) : null;
    return () => {
      off = true;
      if (every) clearInterval(every);
      if (retry) clearTimeout(retry);
    };
  }, [trade.ticker, tf, live, seen]);

  useEffect(() => {
    if (!box.current || !bars?.length) return;
    const gain = css("--gain", "#3fb59d");
    const loss = css("--loss", "#e66767");
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted", "#898781"), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--axis", "#4a4a46") + "55" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: tf === "5m", secondsVisible: false },
    });
    const shift = tf === "5m" ? etOffsetMinutes(bars[0].time * 1000) * 60 : 0;
    const series = chart.addSeries(CandlestickSeries, { upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss });
    const data = bars.map((b) => ({ ...b, time: (b.time + shift) as UTCTimestamp }));
    // Sub-dollar stocks trade in finer ticks: show 4 decimals instead of cents.
    const lastClose = bars[bars.length - 1].close;
    series.applyOptions({ priceFormat: lastClose < 1 ? { type: "price", precision: 4, minMove: 0.0001 } : { type: "price", precision: 2, minMove: 0.01 } });
    series.setData(data);

    // Keep the entry, stop and target on screen even when price is far from them.
    const levels = [trade.entryPrice, trade.limitPrice, trade.stop, trade.initialStop, trade.target, trade.exitPrice, held?.entry, held?.stop, held?.target].filter((v): v is number => typeof v === "number" && v > 0);
    series.applyOptions({
      autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
        const r = orig();
        if (!r?.priceRange || !levels.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...levels), maxValue: Math.max(r.priceRange.maxValue, ...levels) } };
      },
    });
    const line = (price: number | null | undefined, color: string, title: string, style = LineStyle.Solid) => {
      if (price) series.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title });
    };
    const entry = trade.entryPrice ?? (trade.entryType && trade.entryType !== "market" ? trade.limitPrice : null);
    line(entry, css("--spot", "#3987e5"), trade.entryPrice ? "entry" : trade.entryType === "stop" ? "entry stop" : "limit", trade.entryPrice ? LineStyle.Solid : LineStyle.Dashed);
    line(trade.stop, loss, "stop");
    if (trade.initialStop !== trade.stop) line(trade.initialStop, loss, "initial stop", LineStyle.Dotted);
    line(trade.target, gain, "target", LineStyle.Dashed);
    if (held) {
      const c = css("--accent", "#e0b73b");
      line(held.entry, c, held.label);
      line(held.stop, c, "your stop", LineStyle.Dotted);
      line(held.target, c, "your target", LineStyle.Dotted);
    }
    if (trade.exitPrice) line(trade.exitPrice, css("--muted", "#898781"), `exit (${trade.exitReason})`, LineStyle.Dotted);

    // Markers sit on the bar that holds the entry / exit time.
    const barAt = (ms: number | null | undefined) => {
      if (!ms) return null;
      const t = tf === "D" ? Date.parse(new Date(ms - 5 * 3600_000).toISOString().slice(0, 10) + "T00:00:00Z") / 1000 : Math.floor(ms / 1000 / 300) * 300 + shift;
      const hit = [...data].reverse().find((b) => b.time <= t);
      return hit?.time ?? null;
    };
    const long = trade.direction === "long";
    const markers = [];
    const et = barAt(trade.entryTime);
    if (et) markers.push({ time: et, position: long ? ("belowBar" as const) : ("aboveBar" as const), shape: long ? ("arrowUp" as const) : ("arrowDown" as const), color: css("--spot", "#3987e5"), text: `${long ? "Buy" : "Short"} ${trade.entryPrice}` });
    const ht = held ? barAt(held.time) : null;
    if (held && ht) markers.push({ time: ht, position: held.long ? ("belowBar" as const) : ("aboveBar" as const), shape: held.long ? ("arrowUp" as const) : ("arrowDown" as const), color: css("--accent", "#e0b73b"), text: `${held.long ? "Bought" : "Shorted"} ${held.entry}` });
    const xt = barAt(trade.exitTime);
    if (xt) markers.push({ time: xt, position: long ? ("aboveBar" as const) : ("belowBar" as const), shape: long ? ("arrowDown" as const) : ("arrowUp" as const), color: (trade.pl ?? 0) >= 0 ? gain : loss, text: `${trade.exitReason} ${trade.exitPrice}` });
    markers.sort((a, b) => a.time - b.time);
    if (markers.length) createSeriesMarkers(series, markers);
    // Open / high / low / close of the bar under the crosshair (the latest bar when not hovering).
    const dp = lastClose < 1 ? 4 : 2;
    // The % change is against the previous bar's close (the way a quote screen shows a day's move), not the bar's open.
    const show = (b: { time?: unknown; open: number; high: number; low: number; close: number } | undefined) => {
      if (!legend.current) return;
      const x = b ?? data[data.length - 1];
      const t = typeof x.time === "number" ? x.time : (data[data.length - 1].time as number);
      let prev: number | null = null;
      for (let i = data.length - 1; i >= 0; i--) {
        if ((data[i].time as number) < t) {
          prev = data[i].close;
          break;
        }
      }
      const base = prev ?? x.open;
      const chg = base ? ((x.close - base) / base) * 100 : 0;
      legend.current.textContent = `O ${x.open.toFixed(dp)}  H ${x.high.toFixed(dp)}  L ${x.low.toFixed(dp)}  C ${x.close.toFixed(dp)}  ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
      legend.current.style.color = chg >= 0 ? gain : loss;
    };
    show(undefined);
    cur.current = {
      lastBar: { ...data[data.length - 1] },
      tf,
      shift,
      update: (b) => {
        series.update(b);
        show(b);
      },
    };
    chart.subscribeCrosshairMove((p) => show(p.time ? (p.seriesData.get(series) as { time?: unknown; open: number; high: number; low: number; close: number } | undefined) : undefined));
    if (tf === "D") chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 90), to: data.length + 3 });
    else chart.timeScale().fitContent();
    return () => {
      cur.current = null;
      chart.remove();
    };
  }, [bars, tf, trade, held]);

  // Move the newest candle with the live quote (regular session only), starting a new candle when its time comes.
  useEffect(() => {
    const c = cur.current;
    if (!c || !last || !(last > 0) || !regularSession()) return;
    const now = Date.now();
    const t = (c.tf === "D" ? Date.parse(todayET(now) + "T00:00:00Z") / 1000 : Math.floor(now / 1000 / 300) * 300 + c.shift) as UTCTimestamp;
    if (t < c.lastBar.time) return;
    const b: Ohlc =
      t > c.lastBar.time
        ? { time: t, open: last, high: last, low: last, close: last }
        : { ...c.lastBar, high: Math.max(c.lastBar.high, last), low: Math.min(c.lastBar.low, last), close: last };
    c.lastBar = b;
    c.update(b);
  }, [last, bars, tf, trade, held]);

  return (
    <div className="mt-2" ref={wrap}>
      <div className="mb-1 flex items-center gap-1 text-xs">
        {(["D", "5m"] as const).map((k) => (
          <button key={k} onClick={() => setTf(k)} className={`rounded px-2 py-0.5 ${tf === k ? "bg-surface text-ink" : "text-muted"}`}>
            {k === "D" ? "Daily" : "5 min"}
          </button>
        ))}
        <span ref={legend} className="num ml-2 whitespace-pre" />
        {err && <span className="text-loss">{err}</span>}
      </div>
      <div className="relative">
        {/* Ticker watermark behind the candles (the chart's own background is transparent). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex select-none items-center justify-center text-7xl font-black tracking-widest text-ink opacity-[0.07] md:text-9xl">
          {trade.ticker}
        </div>
        <div ref={box} className="relative h-[32rem] w-full" />
      </div>
    </div>
  );
}
