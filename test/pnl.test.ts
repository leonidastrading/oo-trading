import { describe, expect, it } from "vitest";
import { dailyCloses, mondayOf, weeklyRows } from "@/lib/pnl";

describe("weekly P/L", () => {
  it("finds the Monday of a week", () => {
    expect(mondayOf("2026-10-23")).toBe("2026-10-19");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
  });

  it("uses snapshots, back-fills earlier days from realized P/L, and strips transfers", () => {
    const input = {
      from: "2026-10-19",
      today: "2026-10-27",
      // Snapshots Thu 22 and Fri 23 (Thu's startNetLiq is Wed's close); live value today.
      closes: { "2026-10-22": 1_002_000, "2026-10-23": 1_003_000, "2026-10-27": 1_051_000 },
      priorCloses: { "2026-10-22": 1_001_000 },
      realized: { "2026-10-19": 500, "2026-10-20": 300, "2026-10-21": 200, "2026-10-26": 1000 },
      transfers: { "2026-10-27": 50_000 },
    };
    const days = dailyCloses(input);
    expect(days[0]).toEqual({ date: "2026-10-16", equity: 1_000_000, estimated: true });
    expect(days.find((d) => d.date === "2026-10-21")).toEqual({ date: "2026-10-21", equity: 1_001_000, estimated: false });
    expect(days.find((d) => d.date === "2026-10-26")!.equity).toBe(1_001_000); // back-filled from today, minus the deposit

    const [w1, w2] = weeklyRows(input);
    expect(w1).toMatchObject({ week: "2026-10-19", end: "2026-10-23", startEquity: 1_000_000, endEquity: 1_003_000, pl: 3000, estimated: true });
    expect(w1.plPct).toBeCloseTo(0.003);
    expect(w2).toMatchObject({ week: "2026-10-26", end: "2026-10-27", startEquity: 1_003_000, transfers: 50_000, pl: -2000, current: true });
    expect(w2.plPct).toBeCloseTo(-2000 / 1_053_000); // deposit counts toward the base
  });
});

describe("funding week", () => {
  it("treats a near-zero back-filled start as an empty account", () => {
    const [w] = weeklyRows({
      from: "2026-10-19",
      today: "2026-10-23",
      closes: { "2026-10-23": 4_545_975.73 },
      priorCloses: {},
      realized: { "2026-10-23": -75_082.63 },
      transfers: { "2026-10-19": 4_620_956.92 },
    });
    expect(w).toMatchObject({ startEquity: 0, pl: -74_981.19, estimated: false });
    expect(w.plPct).toBeCloseTo(-74_981.19 / 4_620_956.92);
  });
});
