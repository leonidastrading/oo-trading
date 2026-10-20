import { describe, expect, it } from "vitest";
import type { OOTrade } from "@/lib/ooCsv";
import { bestWorstDays, dailyPnl, dailyToCsv, maxDrawdown, statsByStrategy } from "@/lib/stats";

const t = (strategy: string, date: string, pl: number, reason = "Expired", contracts = 1): OOTrade => ({
  key: `${strategy}${date}${pl}`,
  strategy,
  dateOpened: date,
  timeOpened: "10:00:00",
  legs: "",
  premium: null,
  dateClosed: date,
  timeClosed: "16:00:00",
  reason,
  pl,
  contracts,
  fundsAtClose: null,
  openFees: 1,
  closeFees: 1,
});

const trades = [
  t("A", "2026-10-19", 300, "Expired", 2),
  t("A", "2026-10-20", -200, "Stop Loss", 2),
  t("A", "2026-10-21", -100, "Expired", 2),
  t("B", "2026-10-20", 500),
  t("B", "2026-10-21", -50, "Profit Target"),
];

describe("statsByStrategy", () => {
  const rows = statsByStrategy(trades);
  const a = rows.find((r) => r.strategy === "A")!;
  it("computes per-strategy stats", () => {
    expect(a.trades).toBe(3);
    expect(a.winPct).toBeCloseTo(33.33, 1);
    expect(a.totalPl).toBe(0);
    expect(a.avgPlPerLot).toBe(0);
    expect(a.avgWinner).toBe(300);
    expect(a.avgLoser).toBe(-150);
    expect(a.maxWinner).toBe(300);
    expect(a.maxLoser).toBe(-200);
    expect(a.losersPctByKind).toEqual({ stop: 50, expired: 50, other: 0 });
    expect(a.lostByKind).toEqual({ stop: -200, expired: -100, other: 0 });
  });
  it("adds an All row", () => {
    expect(rows.at(-1)!.strategy).toBe("All strategies");
    expect(rows.at(-1)!.totalPl).toBe(450);
  });
});

describe("daily series", () => {
  const rows = dailyPnl(trades);
  it("sums per day and accumulates", () => {
    expect(rows.map((r) => [r.date, r.total, r.cumulative])).toEqual([
      ["2026-10-19", 300, 300],
      ["2026-10-20", 300, 600],
      ["2026-10-21", -150, 450],
    ]);
    expect(rows[1].byStrategy).toEqual({ A: -200, B: 500 });
    expect(rows[2].drawdown).toBe(-150);
    expect(maxDrawdown(rows)).toEqual({ amount: -150, date: "2026-10-21" });
  });
  it("ranks best and worst days", () => {
    const { best, worst } = bestWorstDays(rows, 10);
    expect(best.map((r) => r.date)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(worst.map((r) => r.date)).toEqual(["2026-10-21"]);
  });
  it("exports CSV", () => {
    const csv = dailyToCsv(rows, ["A", "B"]).trim().split("\n");
    expect(csv[0]).toBe("Date,Day Total,A,B,Cumulative");
    expect(csv[2]).toBe("2026-10-20,300.00,-200.00,500.00,600.00");
  });
});
