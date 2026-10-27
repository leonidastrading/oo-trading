"use client";

import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { SpxDayData } from "@/app/api/spx-day/route";
import { money } from "./format";
import { usePoll } from "./usePoll";
import { etOffsetMinutes, formatTimeET } from "@/lib/time";

const ABBR: Record<string, string> = {
  "Iron condor": "IC",
  "Put credit spread": "PCS",
  "Call credit spread": "CCS",
  "Put debit spread": "PDS",
  "Call debit spread": "CDS",
  "Put broken-wing butterfly": "BWB",
  "Call broken-wing butterfly": "Call BWB",
  "Long straddle": "Straddle",
};
const abbr = (label: string) => ABBR[label] ?? label;
const compactMoney = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.round(Math.abs(v))}`;
const priceText = (p: number) => `${p >= 0 ? "cr" : "db"} ${Math.abs(p).toFixed(2)}`;

const css = (name: string, fallback: string) =>
  (typeof window !== "undefined" && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

export function SpxDayChart() {
  const { data, error } = usePoll<SpxDayData>("/api/spx-day");
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!box.current || !data?.bars.length) return;
    // lightweight-charts shows UTC; shift by the ET offset so the axis reads New York time.
    const shift = etOffsetMinutes(data.bars[0].time * 1000) * 60;
    const gain = css("--gain", "#3fb59d");
    const loss = css("--loss", "#e66767");
    const chart = createChart(box.current, {
      autoSize: true,
      // Marker labels use the layout font size.
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted", "#898781"), fontSize: 14 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--axis", "#4a4a46") + "55" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: gain,
      downColor: loss,
      borderVisible: false,
      wickUpColor: gain,
      wickDownColor: loss,
    });
    series.setData(data.bars.map((b) => ({ ...b, time: (b.time + shift) as UTCTimestamp })));
    const minute = (t: number) => (Math.floor((t + shift) / 60) * 60) as UTCTimestamp;
    const markers = [
      ...data.entries.map((e) => ({
        time: minute(e.time),
        position: "belowBar" as const,
        shape: "arrowUp" as const,
        color: e.price >= 0 ? css("--accent", "#e0b73b") : css("--spot", "#3987e5"),
        text: `${abbr(e.label)} ${e.contracts}`,
        size: 1.4,
      })),
      ...(data.exits ?? []).map((x) => ({
        time: minute(x.time),
        position: "aboveBar" as const,
        shape: "arrowDown" as const,
        color: (x.realized ?? 0) < 0 ? loss : gain,
        text: `${(x.realized ?? 0) < 0 ? "Stop" : "Exit"} ${abbr(x.label)} ${x.contracts}${x.realized !== null ? ` ${compactMoney(x.realized)}` : ""}`,
        size: 1.4,
      })),
    ].sort((a, b) => a.time - b.time);
    createSeriesMarkers(series, markers);
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  const dateLabel = data ? new Date(data.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";

  return (
    <section className="card space-y-3 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent">SPX · 1-minute</h2>
        <span className="text-xs text-muted">
          {dateLabel}
          {data ? ` · ${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"} · ${(data.exits ?? []).filter((x) => (x.realized ?? 0) < 0).length} stopped` : ""}
        </span>
      </header>
      {(error || (data?.meta.errors.length ?? 0) > 0) && <p className="text-sm text-loss">{error ?? data?.meta.errors.join(" · ")}</p>}
      {data && !data.bars.length ? (
        <p className="text-sm text-muted">No bars for this session yet.</p>
      ) : (
        <div ref={box} className="h-[36rem] w-full md:h-[48rem]" />
      )}
      {data && data.entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Trade</th>
                <th>Size</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.orderId}>
                  <td className="whitespace-nowrap">{formatTimeET(e.time * 1000).replace(" ET", "")}</td>
                  <td>{e.label}</td>
                  <td className="num">{e.contracts}</td>
                  <td className="num">{priceText(e.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (data.exits?.length ?? 0) > 0 && (
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>Exit</th>
                <th>Trade</th>
                <th>Size</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {data.exits.map((x) => (
                <tr key={x.orderId}>
                  <td className="whitespace-nowrap">
                    {formatTimeET(x.time * 1000).replace(" ET", "")}
                    {(x.realized ?? 0) < 0 && <span className="ml-2 text-xs text-loss">stop</span>}
                  </td>
                  <td>{x.label}</td>
                  <td className="num">{x.contracts}</td>
                  <td className={x.realized === null ? "text-muted" : x.realized < 0 ? "text-loss" : "text-gain"}>
                    {x.realized === null ? "—" : money(x.realized, { sign: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Markers sit on the minute of each opening order (all legs of one Schwab order = one entry);{" "}
        <span className="text-accent">▲</span> credit entry, <span className="text-spot">▲</span> debit entry,{" "}
        <span className="text-loss">▼</span> stop (closed at a loss), <span className="text-gain">▼</span> exit at a gain. Expirations aren&apos;t marked. Times ET.
      </p>
    </section>
  );
}
