"use client";

import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { SpxDailyData } from "@/app/api/spx-daily/route";
import type { SpxDayData } from "@/app/api/spx-day/route";
import { money } from "./format";
import { usePoll } from "./usePoll";
import { etOffsetMinutes, etParts, formatTimeET } from "@/lib/time";

const ABBR: Record<string, string> = {
  "Iron condor": "IC",
  "Put credit spread": "PS",
  "Call credit spread": "CS",
  "Put debit spread": "PS",
  "Call debit spread": "CS",
  "Put broken-wing butterfly": "BWB",
  "Call broken-wing butterfly": "BWB",
  "Long straddle": "Straddle",
};
const abbr = (label: string) => label.split(" / ").map((l) => ABBR[l] ?? l).join("/");
/** Chart name: multi-day trades go by their DTE (1DTE, 2DTE), same-day ones by structure. */
const shortName = (label: string, dte: number | null | undefined) => (dte && dte > 0 ? `${dte}DTE` : abbr(label));
/** A loss closed before 3:45 PM is a stop; closes in the last 15 minutes are scheduled time exits. */
const isStop = (x: { time: number; realized: number | null }) => (x.realized ?? 0) < 0 && etParts(x.time * 1000).minutesOfDay < 15 * 60 + 45;
const priceText = (p: number) => `${p >= 0 ? "cr" : "db"} ${Math.abs(p).toFixed(2)}`;

const TIMEFRAMES = [
  { key: "1m", min: 1 },
  { key: "5m", min: 5 },
  { key: "30m", min: 30 },
  { key: "1h", min: 60 },
  { key: "D", min: 0 },
] as const;
type Timeframe = (typeof TIMEFRAMES)[number]["key"];
type Style = "bars" | "candles" | "line";
const STYLES: { key: Style; icon: string; title: string }[] = [
  { key: "bars", icon: "┤├", title: "Bars" },
  { key: "candles", icon: "▮▯", title: "Candles" },
  { key: "line", icon: "╱╲", title: "Line" },
];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {}
}

interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Roll 1-minute bars (ET-shifted seconds) into `min`-minute bars aligned to the 9:30 open, like TradingView. */
function aggregate(bars: Ohlc[], min: number, anchor: number): Ohlc[] {
  if (min <= 1) return bars;
  const size = min * 60;
  const out: Ohlc[] = [];
  for (const b of bars) {
    const t = anchor + Math.floor((b.time - anchor) / size) * size;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
    } else out.push({ ...b, time: t });
  }
  return out;
}

const css = (name: string, fallback: string) =>
  (typeof window !== "undefined" && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

export interface BestCloseLine {
  price: number;
  pnl: number;
}

export function SpxDayChart({ best }: { best?: BestCloseLine | null }) {
  const { data, error } = usePoll<SpxDayData>("/api/spx-day");
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<Timeframe>("1m");
  const [style, setStyle] = useState<Style>("candles");
  const [daily, setDaily] = useState<SpxDailyData | null>(null);
  // Keep the viewer's zoom/scroll across data refreshes (reset when the timeframe changes).
  const viewRef = useRef<{ tf: Timeframe; range: { from: number; to: number } | null } | null>(null);
  const bestPrice = best && best.pnl > 0 ? best.price : null;
  const bestPnl = best?.pnl ?? 0;

  // Restore the viewer's last choice after hydration (localStorage isn't available on the server).
  useEffect(() => {
    void Promise.resolve().then(() => {
      setTf(stored("spxChart.tf", TIMEFRAMES.map((t) => t.key), "1m"));
      setStyle(stored("spxChart.style", STYLES.map((t) => t.key), "candles"));
    });
  }, []);

  useEffect(() => {
    if (tf !== "D" || daily) return;
    fetch("/api/spx-daily", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: SpxDailyData) => setDaily(d))
      .catch(() => setDaily({ bars: [], error: "Couldn't load daily bars" }));
  }, [tf, daily]);

  useEffect(() => {
    const isDaily = tf === "D";
    if (!box.current || !data?.bars.length || (isDaily && !daily?.bars.length)) return;
    // lightweight-charts shows UTC; shift by the ET offset so the axis reads New York time.
    const shift = etOffsetMinutes(data.bars[0].time * 1000) * 60;
    const gain = css("--gain", "#3fb59d");
    const loss = css("--loss", "#e66767");
    const chart = createChart(box.current, {
      autoSize: true,
      // Marker labels use the layout font size.
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted", "#898781"), fontSize: 16 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--axis", "#4a4a46") + "55" } },
      rightPriceScale: { borderVisible: false },
      // Room after the last bar so labels near the close aren't clipped.
      timeScale: { borderVisible: false, timeVisible: !isDaily, secondsVisible: false, rightOffset: isDaily ? 4 : 12 },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const minutes = TIMEFRAMES.find((t) => t.key === tf)!.min;
    const shifted = data.bars.map((b) => ({ ...b, time: b.time + shift }));
    const anchor = Math.floor(shifted[0].time / 86_400) * 86_400 + (9 * 60 + 30) * 60;
    let bars: Ohlc[] = isDaily ? daily!.bars : aggregate(shifted, minutes, anchor);
    // Schwab adds the session to its daily history overnight: build today's daily bar from the 1-minute bars.
    const dayStart = Math.floor(shifted[0].time / 86_400) * 86_400;
    if (isDaily && (bars[bars.length - 1]?.time ?? 0) < dayStart) {
      bars = [
        ...bars,
        {
          time: dayStart,
          open: shifted[0].open,
          high: Math.max(...shifted.map((b) => b.high)),
          low: Math.min(...shifted.map((b) => b.low)),
          close: shifted[shifted.length - 1].close,
        },
      ];
    }
    let series: ISeriesApi<SeriesType>;
    if (style === "line") {
      series = chart.addSeries(LineSeries, { color: css("--spot", "#3987e5"), lineWidth: 2, priceLineVisible: true });
      series.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })));
    } else if (style === "bars") {
      series = chart.addSeries(BarSeries, { upColor: gain, downColor: loss, thinBars: false });
      series.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    } else {
      series = chart.addSeries(CandlestickSeries, { upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss });
      series.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    }
    if (bestPrice !== null) {
      series.createPriceLine({
        price: bestPrice,
        color: css("--gain", "#3fb59d"),
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Best close ${money(bestPnl, { sign: true })}`,
      });
    }
    // Markers land on the bar that contains them (none on the daily view).
    const size = Math.max(minutes, 1) * 60;
    const minute = (t: number) => (anchor + Math.floor((t + shift - anchor) / size) * size) as UTCTimestamp;
    // Short numbered labels (matching the # column below); markers in the same minute are merged.
    const num = new Map(data.entries.map((e, i) => [e.orderId, i + 1]));
    type Kind = "credit" | "debit" | "stop" | "win" | "timeLoss";
    const groups = new Map<string, { time: UTCTimestamp; kind: Kind; nums: string[]; tags: string[] }>();
    const add = (t: number, kind: Kind, nums: string, tag: string) => {
      const time = minute(t);
      const g = groups.get(`${time}|${kind}`) ?? { time, kind, nums: [], tags: [] };
      if (!g.nums.includes(nums)) g.nums.push(nums);
      if (!g.tags.includes(tag)) g.tags.push(tag);
      groups.set(`${time}|${kind}`, g);
    };
    for (const e of data.entries) add(e.time, e.price >= 0 ? "credit" : "debit", String(num.get(e.orderId)), shortName(e.label, e.dte));
    for (const x of data.exits ?? []) {
      const kind: Kind = isStop(x) ? "stop" : (x.realized ?? 0) < 0 ? "timeLoss" : "win";
      const ids = (x.closes ?? []).map((id) => num.get(id)).filter((n): n is number => n !== undefined);
      add(x.time, kind, ids.length ? ids.join(",") : "?", shortName(x.label, x.dte));
    }
    const colors: Record<Kind, string> = {
      credit: css("--accent", "#e0b73b"),
      debit: css("--spot", "#3987e5"),
      stop: loss,
      win: gain,
      timeLoss: css("--muted", "#898781"),
    };
    // Arrows come from the library; the two-line labels are HTML laid over the chart (see place()).
    const labels = [...groups.values()]
      .sort((x, y) => x.time - y.time)
      .map((g) => {
        const exit = g.kind === "stop" || g.kind === "win" || g.kind === "timeLoss";
        const nums = g.nums.join(",");
        return { ...g, exit, top: g.kind === "stop" ? `S${nums}` : exit ? `x${nums}` : nums, tag: g.tags.join("/"), color: colors[g.kind] };
      });
    const markers = labels.map((l) => ({
      time: l.time,
      position: l.exit ? ("aboveBar" as const) : ("belowBar" as const),
      shape: l.exit ? ("arrowDown" as const) : ("arrowUp" as const),
      color: l.color,
      text: "",
      size: 1.5,
    }));
    const barAt = new Map(bars.map((b) => [b.time, b]));
    const overlay = overlayRef.current;
    const els: HTMLDivElement[] = [];
    if (overlay && !isDaily) {
      overlay.replaceChildren();
      for (const l of labels) {
        const el = document.createElement("div");
        el.className = "absolute whitespace-nowrap text-center text-[13px] font-semibold leading-tight md:text-sm";
        el.style.color = l.color;
        const a = document.createElement("div");
        a.textContent = l.top;
        const b2 = document.createElement("div");
        b2.textContent = l.tag;
        b2.className = "font-medium opacity-90";
        el.append(a, b2);
        overlay.append(el);
        els.push(el);
      }
    } else overlay?.replaceChildren();
    const GAP = 26; // px between the bar's high/low and its label, clear of the arrow
    // The library stacks several arrows on one bar; clear all of them.
    const arrowsOn = new Map<string, number>();
    for (const l of labels) arrowsOn.set(`${l.time}|${l.exit}`, (arrowsOn.get(`${l.time}|${l.exit}`) ?? 0) + 1);
    const place = () => {
      // Greedy lanes: a label that would overlap the previous one on its side is pushed further out.
      const lanes: Record<"above" | "below", { right: number; lane: number }[]> = { above: [], below: [] };
      labels.forEach((l, i) => {
        const el = els[i];
        const bar = barAt.get(l.time);
        const x = chart.timeScale().timeToCoordinate(l.time);
        const y = bar ? series.priceToCoordinate(l.exit ? bar.high : bar.low) : null;
        if (!el) return;
        if (x === null || y === null) {
          el.style.display = "none";
          return;
        }
        el.style.display = "";
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const left = x - w / 2;
        const side = l.exit ? "above" : "below";
        const used = lanes[side].filter((p) => p.right > left - 4).map((p) => p.lane);
        let lane = 0;
        while (used.includes(lane)) lane++;
        lanes[side].push({ right: left + w, lane });
        const offset = GAP + ((arrowsOn.get(`${l.time}|${l.exit}`) ?? 1) - 1) * 20 + lane * (h + 4);
        el.style.left = `${left}px`;
        el.style.top = `${l.exit ? y - offset - h : y + offset}px`;
      });
    };
    if (!isDaily) createSeriesMarkers(series, markers);
    const relayout = () => requestAnimationFrame(place);
    chart.timeScale().subscribeVisibleLogicalRangeChange(relayout);
    const ro = new ResizeObserver(relayout);
    ro.observe(box.current);
    // Vertical zoom/scroll doesn't fire a time-range event; re-place after any pointer interaction.
    const boxEl = box.current;
    boxEl.addEventListener("pointermove", relayout);
    boxEl.addEventListener("wheel", relayout, { passive: true });
    const saved = viewRef.current;
    if (saved && saved.tf === tf && saved.range) chart.timeScale().setVisibleLogicalRange(saved.range);
    else {
      chart.timeScale().fitContent();
      chart.timeScale().applyOptions({ rightOffset: isDaily ? 4 : 12 });
    }
    relayout();
    return () => {
      ro.disconnect();
      boxEl.removeEventListener("pointermove", relayout);
      boxEl.removeEventListener("wheel", relayout);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(relayout);
      overlay?.replaceChildren();
      viewRef.current = { tf, range: chart.timeScale().getVisibleLogicalRange() };
      chart.remove();
      chartRef.current = null;
    };
  }, [data, daily, tf, style, bestPrice, bestPnl]);

  const dateLabel = data ? new Date(data.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";

  return (
    <section className="card space-y-3 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent">SPX · {tf === "D" ? "daily" : tf}</h2>
        <span className="text-xs text-muted">
          {dateLabel}
          {data ? ` · ${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"} · ${(data.exits ?? []).filter(isStop).length} stopped` : ""}
        </span>
      </header>
      <div className="flex items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-page/60 p-1 text-sm" role="toolbar" aria-label="Chart options">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTf(t.key);
              store("spxChart.tf", t.key);
            }}
            aria-pressed={tf === t.key}
            className={`shrink-0 rounded-md px-2 py-1 ${tf === t.key ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            {t.key}
          </button>
        ))}
        <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
        {STYLES.map((st) => (
          <button
            key={st.key}
            title={st.title}
            aria-label={st.title}
            onClick={() => {
              setStyle(st.key);
              store("spxChart.style", st.key);
            }}
            aria-pressed={style === st.key}
            className={`shrink-0 rounded-md px-2 py-1 font-mono ${style === st.key ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            {st.icon}
          </button>
        ))}
      </div>
      {(error || (data?.meta.errors.length ?? 0) > 0) && <p className="text-sm text-loss">{error ?? data?.meta.errors.join(" · ")}</p>}
      {data && !data.bars.length ? (
        <p className="text-sm text-muted">No bars for this session yet.</p>
      ) : (
        <div className="relative">
          <div ref={box} className="h-[36rem] w-full md:h-[48rem]" />
          <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden />
        </div>
      )}
      {data && data.entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>Entry</th>
                <th>Trade</th>
                <th>Size</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={e.orderId}>
                  <td className={e.price >= 0 ? "text-accent" : "text-spot"}>{i + 1}</td>
                  <td className="whitespace-nowrap">{formatTimeET(e.time * 1000).slice(0, 5)}</td>
                  <td>
                    <span className="md:hidden">{shortName(e.label, e.dte)}</span>
                    <span className="hidden md:inline">
                      {e.label}
                      {e.dte > 0 ? ` · ${e.dte}DTE` : ""}
                    </span>
                  </td>
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
                <th>#</th>
                <th>Exit</th>
                <th>Trade</th>
                <th>Size</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {data.exits.map((x) => (
                <tr key={x.orderId}>
                  <td className={isStop(x) ? "text-loss" : "text-muted"}>
                    {(isStop(x) ? "S" : "x") +
                      ((x.closes ?? []).map((id) => data.entries.findIndex((e) => e.orderId === id) + 1).filter((n) => n > 0).join(",") || "?")}
                  </td>
                  <td className="whitespace-nowrap">
                    {formatTimeET(x.time * 1000).slice(0, 5)}
                  </td>
                  <td>
                    <span className="md:hidden">{shortName(x.label, x.dte)}</span>
                    <span className="hidden md:inline">{x.label}</span>
                  </td>
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
        Numbers match the # column: ▲ under a bar is an entry (one Schwab opening order), ▼ above is an exit of that entry (S = stop).{" "}
        <span className="text-accent">▲</span> credit entry, <span className="text-spot">▲</span> debit entry,{" "}
        <span className="text-loss">▼</span> stop (closed at a loss before 3:45 PM), <span className="text-gain">▼</span> exit at a gain,{" "}
        <span className="text-muted">▼</span> time exit at a loss. Expirations aren&apos;t marked. <span className="text-gain">- - -</span> best SPX close for today&apos;s expirations. Times ET.
      </p>
    </section>
  );
}
