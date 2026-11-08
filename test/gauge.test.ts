import { describe, expect, it } from "vitest";
import {
  atmStrike,
  bsPut,
  chipFor,
  closeRow,
  impliedVolPut,
  monthlyMeans,
  putDelta,
  rollingMean,
  series60,
  tenDeltaPut,
  wingKept60,
  type GaugeRow,
} from "@/lib/gauge";

const open = (date: string, straddle: number, K = 7000): GaugeRow => ({
  date,
  s10: K,
  K,
  call_mid: straddle / 2,
  put_mid: straddle / 2,
  straddle,
  s16: null,
  move: null,
  ratio: null,
  edge: null,
  straddle_pct: (straddle / K) * 100,
  status: "open",
  captured_at: 0,
});
const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return d.toISOString().slice(0, 10);
};

describe("0DTE premium gauge", () => {
  it("rounds to the 5-point strike and closes a day into move, ratio and edge", () => {
    expect(atmStrike(7377.6)).toBe(7380);
    expect(atmStrike(7377.4)).toBe(7375);
    const r = closeRow(open("2026-11-09", 40, 7380), 7400);
    expect(r).toMatchObject({ status: "closed", s16: 7400, move: 20, ratio: 0.5, edge: 0.5 });
    // Idempotent: closing again with the same price gives the same numbers.
    expect(closeRow(r, 7400)).toMatchObject({ move: 20, ratio: 0.5 });
  });

  it("shows rolling means only once enough valid days exist", () => {
    const rows = Array.from({ length: 14 }, (_, i) => closeRow(open(day(i), 40), 7000 + 40)); // ratio 1
    expect(rollingMean(rows, 20, 15)).toBeNull();
    rows.push(closeRow(open(day(14), 40), 7020)); // ratio 0.5
    expect(rollingMean(rows, 20, 15)).toEqual({ mean: 0.9667, days: 15 }); // (14 × 1 + 0.5) / 15
    // Skipped days don't count.
    rows.push({ ...open(day(15), 40), status: "skipped", reason: "no same-day expiry" });
    expect(rollingMean(rows, 20, 15)!.days).toBe(15);
    expect(series60(rows)).toEqual([]);
  });

  it("builds the 60-day series and month means over the seed", () => {
    const rows = Array.from({ length: 45 }, (_, i) => closeRow(open(day(i), 40), 7000 + 36)); // ratio 0.9
    const s = series60(rows);
    expect(s).toHaveLength(6);
    expect(s[0].value).toBeCloseTo(0.9, 6);
    const m = monthlyMeans(rows);
    expect(m["2026-01"]).toEqual({ mean: 0.9, days: 31 });
    expect(m["2025-04"]).toEqual({ mean: 1.135, days: null }); // seed
  });

  it("colours the 60-day mean", () => {
    const ends = [{ date: "2026-09-30", value: 0.9 }, { date: "2026-10-30", value: 1.01 }, { date: "2026-11-27", value: 1.02 }];
    expect(chipFor(0.95, ends)).toBe("green");
    expect(chipFor(1.05, ends)).toBe("amber");
    expect(chipFor(1.11, ends)).toBe("red");
    expect(chipFor(0.95, ends.map((e) => ({ ...e, value: 1.01 })))).toBe("red"); // 3 month-ends above 1.0
  });

  it("finds the 10-delta put from mid-implied vols and scores the wing", () => {
    const s = 7000;
    const t = 6 / (365 * 24); // 6 hours
    const iv = 0.18;
    expect(impliedVolPut(bsPut(s, 6950, t, iv), s, 6950, t)).toBeCloseTo(iv, 4);
    const puts = [6900, 6925, 6950, 6975].map((k) => ({ strike: k, mid: bsPut(s, k, t, iv) }));
    const w = tenDeltaPut(puts, s, t)!;
    const deltas = puts.map((p) => Math.abs(putDelta(s, p.strike, t, iv) + 0.1));
    expect(w.strike).toBe(puts[deltas.indexOf(Math.min(...deltas))].strike);
    const rows = [
      closeRow({ ...open("2026-11-09", 40), wing: { strike: 6950, mid: 2, iv, delta: -0.1 } }, 7010),
      closeRow({ ...open("2026-11-10", 40), wing: { strike: 6950, mid: 2, iv, delta: -0.1 } }, 6947),
    ];
    expect(wingKept60(rows)).toEqual({ kept: 1 - 3 / 4, days: 2 });
  });
});
