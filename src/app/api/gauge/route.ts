import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import {
  chipFor,
  monthEndReadings,
  monthlyMeans,
  rollingMean,
  SEED_60D,
  series60,
  wingKept60,
  type Chip,
  type GaugeRow,
} from "@/lib/gauge";
import { captureDue, gaugeRows } from "@/lib/gaugeCapture";
import { tokenStatus } from "@/lib/schwab/tokens";
import { marketSession, todayET } from "@/lib/time";

export const dynamic = "force-dynamic";

export interface GaugeData {
  meta: { pollMs: number | null; errors: string[] };
  today: GaugeRow | null;
  /** The last 30 rows, newest first. */
  recent: GaugeRow[];
  mean20: { mean: number; days: number } | null;
  mean60: { mean: number; days: number } | null;
  /** 60-day mean over time: the carried-over month-end readings, then the live series. */
  series: { date: string; value: number; seed: boolean }[];
  /** Status of the latest 60-day mean (live once 40 days exist, else the last carried-over reading). */
  chip: { value: number; status: Chip; seed: boolean };
  months: Record<string, { mean: number; days: number | null }>;
  validDays: number;
  wing: { kept: number; days: number } | null;
}

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const errors: string[] = [];
  // While the page is open, take a missed snapshot (10:00–10:10 ET) or close (after 16:00:30) on the way.
  if ((await tokenStatus()).connected) {
    try {
      await captureDue();
    } catch (e) {
      errors.push(`Gauge capture failed: ${(e as Error).message}`);
    }
  }
  const rows = await gaugeRows();
  const live = series60(rows);
  const series = [...SEED_60D.filter((s) => !live.length || s.date < live[0].date).map((s) => ({ ...s, seed: true })), ...live.map((s) => ({ ...s, seed: false }))];
  const last = series[series.length - 1];
  const phase = marketSession().phase;
  const body: GaugeData = {
    meta: { pollMs: phase === "closed" ? null : 60_000, errors },
    today: rows.find((r) => r.date === todayET()) ?? null,
    recent: [...rows].reverse().slice(0, 30),
    mean20: rollingMean(rows, 20, 15),
    mean60: rollingMean(rows, 60, 40),
    series,
    chip: { value: last.value, status: chipFor(last.value, monthEndReadings(series)), seed: last.seed },
    months: monthlyMeans(rows),
    validDays: rows.filter((r) => r.status === "closed").length,
    wing: wingKept60(rows),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
