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
      // Axis labels (time and price); the entry/exit labels are HTML and sized separately.
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted", "#898781"), fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--axis", "#4a4a46") + "55" } },
      // Headroom above and below the bars for the entry/exit labels.
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.22 } },
      // Intraday: the time axis is locked to the whole session, 9:30–4:30 ET (no horizontal zoom/scroll).
      timeScale: { borderVisible: false, timeVisible: !isDaily, secondsVisible: false, rightOffset: isDaily ? 4 : 0 },
      handleScroll: isDaily,
      handleScale: isDaily,
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
    // Empty slots after the last bar up to 4:30 PM, so the full session is always on screen.
    const sessionEnd = anchor + 7 * 3600;
    const step = Math.max(minutes, 1) * 60;
    const whitespace: { time: UTCTimestamp }[] = [];
    if (!isDaily) {
      for (let t = (bars[bars.length - 1]?.time ?? anchor - step) + step; t <= sessionEnd; t += step) whitespace.push({ time: t as UTCTimestamp });
    }
    let series: ISeriesApi<SeriesType>;
    if (style === "line") {
      series = chart.addSeries(LineSeries, { color: css("--spot", "#3987e5"), lineWidth: 2, priceLineVisible: true });
      series.setData([...bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })), ...whitespace]);
    } else if (style === "bars") {
      series = chart.addSeries(BarSeries, { upColor: gain, downColor: loss, thinBars: false });
      series.setData([...bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })), ...whitespace]);
    } else {
      series = chart.addSeries(CandlestickSeries, { upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss });
      series.setData([...bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })), ...whitespace]);
    }
    if (bestPrice !== null) {
      series.createPriceLine({
        price: bestPrice,
        color: css("--gain", "#3fb59d"),
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        // Intraday the P/L is an HTML tag in the price-axis column (see place()), so it never covers bars.
        axisLabelVisible: isDaily,
        title: isDaily ? money(bestPnl, { sign: true }) : "",
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
    const leaders: HTMLDivElement[] = [];
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
        // Thin connector from the arrow to a label that had to be pushed out of the way.
        const lead = document.createElement("div");
        lead.className = "absolute w-px opacity-50";
        lead.style.background = l.color;
        overlay.append(lead, el);
        els.push(el);
        leaders.push(lead);
      }
    } else overlay?.replaceChildren();
    // Stop-outs: a red line from each stopped entry to its stop, under the labels.
    const stopPairs = isDaily
      ? []
      : (data.exits ?? []).filter(isStop).flatMap((x) =>
          (x.closes ?? []).flatMap((id) => {
            const e = data.entries.find((en) => en.orderId === id);
            return e ? [{ from: minute(e.time), to: minute(x.time) }] : [];
          }),
        );
    const svgNs = "http://www.w3.org/2000/svg";
    const stopLines: SVGLineElement[] = [];
    if (overlay && stopPairs.length) {
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("class", "absolute inset-0 h-full w-full");
      for (let i = 0; i < stopPairs.length; i++) {
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("stroke", loss);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-linecap", "round");
        svg.append(line);
        stopLines.push(line);
      }
      overlay.prepend(svg);
    }
    let bestEl: HTMLDivElement | null = null;
    if (overlay && !isDaily && bestPrice !== null) {
      bestEl = document.createElement("div");
      bestEl.className = "absolute whitespace-nowrap rounded-sm py-0.5 text-center text-xs font-semibold";
      bestEl.title = `Best close ${bestPrice}`;
      bestEl.style.background = css("--gain", "#3fb59d");
      bestEl.style.color = css("--page", "#0c0c0b");
      bestEl.textContent = money(bestPnl, { sign: true });
      overlay.append(bestEl);
    }
    const GAP = 26; // px between the bar's high/low and its label, clear of the arrow
    // The library stacks several arrows on one bar; clear all of them.
    const arrowsOn = new Map<string, number>();
    for (const l of labels) arrowsOn.set(`${l.time}|${l.exit}`, (arrowsOn.get(`${l.time}|${l.exit}`) ?? 0) + 1);
    const place = () => {
      // Each label starts next to its arrow and moves further out if it would overlap one already placed;
      // when it would leave the chart it slides sideways along the edge instead, so every label stays visible.
      const paneH = (box.current?.clientHeight ?? 0) - chart.timeScale().height();
      const paneW = (box.current?.clientWidth ?? 0) - chart.priceScale("right").width();
      // Entry → stop lines, from the entry bar's close to the stop bar's close.
      stopPairs.forEach((p, i) => {
        const ln = stopLines[i];
        const a = barAt.get(p.from);
        const b = barAt.get(p.to);
        const x1 = chart.timeScale().timeToCoordinate(p.from);
        const x2 = chart.timeScale().timeToCoordinate(p.to);
        const y1 = a ? series.priceToCoordinate(a.close) : null;
        const y2 = b ? series.priceToCoordinate(b.close) : null;
        if (!ln) return;
        if (x1 === null || x2 === null || y1 === null || y2 === null) {
          ln.style.display = "none";
          return;
        }
        ln.style.display = "";
        ln.setAttribute("x1", String(x1));
        ln.setAttribute("y1", String(y1));
        ln.setAttribute("x2", String(x2));
        ln.setAttribute("y2", String(y2));
      });
      const placed: { l: number; t: number; r: number; b: number }[] = [];
      // Best-close P/L in the price-axis column at its line's level (no candles there), nudged clear of the
      // live price label when the two are close.
      const by = bestPrice !== null ? series.priceToCoordinate(bestPrice) : null;
      if (bestEl) {
        if (by === null || by < 0 || by > paneH) bestEl.style.display = "none";
        else {
          bestEl.style.display = "";
          const axisW = chart.priceScale("right").width();
          bestEl.style.width = `${Math.max(axisW - 2, 0)}px`;
          const h = bestEl.offsetHeight;
          let top = by - h / 2;
          const last = bars[bars.length - 1];
          const ly = last ? series.priceToCoordinate(last.close) : null;
          if (ly !== null && Math.abs(ly - by) < h + 2) top = ly > by ? ly - h / 2 - h - 2 : ly + h / 2 + 2;
          bestEl.style.left = `${paneW + 1}px`;
          bestEl.style.top = `${Math.min(Math.max(0, top), paneH - h)}px`;
        }
      }
      const free = (r: { l: number; t: number; r: number; b: number }) =>
        !placed.some((p) => r.l < p.r + 4 && r.r > p.l - 4 && r.t < p.b + 2 && r.b > p.t - 2);
      labels.forEach((l, i) => {
        const el = els[i];
        const bar = barAt.get(l.time);
        const x = chart.timeScale().timeToCoordinate(l.time);
        const y = bar ? series.priceToCoordinate(l.exit ? bar.high : bar.low) : null;
        if (!el) return;
        const lead = leaders[i];
        if (x === null || y === null) {
          el.style.display = "none";
          if (lead) lead.style.display = "none";
          return;
        }
        el.style.display = "";
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const base = GAP + ((arrowsOn.get(`${l.time}|${l.exit}`) ?? 1) - 1) * 20;
        const minTop = 2;
        const maxTop = Math.max(minTop, paneH - h - 2);
        const clamp = (t: number) => Math.min(maxTop, Math.max(minTop, t));
        // Keep clear of the price scale on the right and the chart's left edge.
        const fitX = (left: number) => Math.min(Math.max(2, left), Math.max(2, paneW - w - 2));
        const at = (left: number, top: number) => ({ l: fitX(left), t: top, r: fitX(left) + w, b: top + h });
        let rect = at(x - w / 2, clamp(l.exit ? y - base - h : y + base));
        // 1) Stack outward while there's room.
        for (let k = 1; !free(rect) && k < 8; k++) {
          const t = l.exit ? y - base - h - k * (h + 4) : y + base + k * (h + 4);
          if (t < minTop || t > maxTop) break;
          rect = at(x - w / 2, t);
        }
        // 2) Out of room: slide along the row, alternating right and left.
        for (let k = 1; !free(rect) && k < 12; k++) {
          const dx = Math.ceil(k / 2) * (w + 4) * (k % 2 ? 1 : -1);
          rect = at(x - w / 2 + dx, rect.t);
        }
        placed.push(rect);
        el.style.left = `${rect.l}px`;
        el.style.top = `${rect.t}px`;
        if (lead) {
          // Connector from just past the arrow to the label, drawn only when the label had to move away.
          const y0 = l.exit ? y - base + 4 : y + base - 4;
          const dx = rect.l + w / 2 - x;
          const dy = (l.exit ? rect.b : rect.t) - y0;
          const moved = Math.abs(dx) > 2 || Math.abs(dy) > 6;
          lead.style.display = moved ? "" : "none";
          // A 1px vertical line from (x, y0), rotated to point at the label.
          lead.style.left = `${x}px`;
          lead.style.top = `${y0}px`;
          lead.style.height = `${Math.hypot(dx, dy)}px`;
          lead.style.transformOrigin = "top left";
          lead.style.transform = `rotate(${(Math.atan2(-dx, dy) * 180) / Math.PI}deg)`;
        }
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
    if (isDaily && saved && saved.tf === tf && saved.range) chart.timeScale().setVisibleLogicalRange(saved.range);
    else if (isDaily) chart.timeScale().fitContent();
    // fitContent ignores trailing empty slots; span every slot from 9:30 to 4:30 explicitly.
    else chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: bars.length + whitespace.length - 0.5 });
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
          <div ref={box} className="h-[24rem] w-full md:h-[32rem]" />
          <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden />
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
        <span className="text-loss">▼</span> stop (closed at a loss before 3:45 PM; a red line joins it to its entry), <span className="text-gain">▼</span> exit at a gain,{" "}
        <span className="text-muted">▼</span> time exit at a loss. Expirations aren&apos;t marked. <span className="text-gain">- - -</span> best SPX close for today&apos;s expirations. Times ET.
      </p>
    </section>
  );
}
