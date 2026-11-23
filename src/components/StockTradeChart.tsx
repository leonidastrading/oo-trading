"use client";

import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle, type AutoscaleInfo, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/lib/schwab/data";
import type { Trade } from "@/lib/stocks/rules";
import { etOffsetMinutes } from "@/lib/time";

const css = (name: string, fallback: string) =>
  (typeof window !== "undefined" && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

/**
 * TradingView-style candles for one trade: entry (and exit) markers, and lines at the entry price, the
 * current stop and the target. Daily or 5-minute bars (the 5-minute axis reads New York time).
 */
export function StockTradeChart({ trade }: { trade: Trade }) {
  const box = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<"D" | "5m">("D");
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    fetch(`/api/stocks/bars?symbol=${encodeURIComponent(trade.ticker)}&tf=${tf}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { bars?: Bar[]; error?: string }) => {
        if (off) return;
        setBars(j.bars ?? []);
        setErr(j.error ?? null);
      })
      .catch(() => !off && setErr("Couldn't load bars"));
    return () => {
      off = true;
    };
  }, [trade.ticker, tf]);

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
    const levels = [trade.entryPrice, trade.limitPrice, trade.stop, trade.initialStop, trade.target, trade.exitPrice].filter((v): v is number => typeof v === "number" && v > 0);
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
    const entry = trade.entryPrice ?? (trade.entryType === "limit" ? trade.limitPrice : null);
    line(entry, css("--spot", "#3987e5"), trade.entryPrice ? "entry" : "limit", trade.entryPrice ? LineStyle.Solid : LineStyle.Dashed);
    line(trade.stop, loss, "stop");
    if (trade.initialStop !== trade.stop) line(trade.initialStop, loss, "initial stop", LineStyle.Dotted);
    line(trade.target, gain, "target", LineStyle.Dashed);
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
    const xt = barAt(trade.exitTime);
    if (xt) markers.push({ time: xt, position: long ? ("aboveBar" as const) : ("belowBar" as const), shape: long ? ("arrowDown" as const) : ("arrowUp" as const), color: (trade.pl ?? 0) >= 0 ? gain : loss, text: `${trade.exitReason} ${trade.exitPrice}` });
    markers.sort((a, b) => a.time - b.time);
    if (markers.length) createSeriesMarkers(series, markers);
    if (tf === "D") chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 90), to: data.length + 3 });
    else chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, tf, trade]);

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1 text-xs">
        {(["D", "5m"] as const).map((k) => (
          <button key={k} onClick={() => setTf(k)} className={`rounded px-2 py-0.5 ${tf === k ? "bg-surface text-ink" : "text-muted"}`}>
            {k === "D" ? "Daily" : "5 min"}
          </button>
        ))}
        {err && <span className="text-loss">{err}</span>}
      </div>
      <div ref={box} className="h-64 w-full" />
    </div>
  );
}
