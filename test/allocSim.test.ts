import { describe, expect, it } from "vitest";
import { impliedAllocations, maxLossPerLot, simulate, toSimTrades } from "@/lib/allocSim";
import type { OOTrade } from "@/lib/ooCsv";

const t = (o: Partial<OOTrade>): OOTrade => ({
  key: "",
  strategy: "PS",
  dateOpened: "2026-03-02",
  timeOpened: "10:00:00",
  legs: "10 Mar 2 5000 P STO 3.00 | 10 Mar 2 4990 P BTO 1.00",
  premium: 200,
  dateClosed: "2026-03-02",
  timeClosed: "16:00:00",
  reason: "Expired",
  pl: 2000,
  contracts: 10,
  fundsAtClose: null,
  openFees: 0,
  closeFees: 0,
  ...o,
});

describe("allocation simulator", () => {
  it("computes risk per contract from the legs (width − credit)", () => {
    expect(maxLossPerLot(t({}))).toEqual({ risk: 800, premium: 200 });
    // Iron condor: only one side can lose.
    const ic = maxLossPerLot(t({ legs: "1 Mar 2 5000 P STO 2 | 1 Mar 2 4990 P BTO 1 | 1 Mar 2 5100 C STO 2 | 1 Mar 2 5110 C BTO 1", contracts: 1 }));
    expect(ic.risk).toBe(800);
  });

  it("prefers OO's margin and re-sizes from allocation and compounding equity", () => {
    const trades = [
      t({ margin: 10_000 }), // 1,000 risk per contract, +200/contract
      t({ dateOpened: "2026-03-03", dateClosed: "2026-03-03", legs: "10 Mar 3 5000 P STO 3.00 | 10 Mar 3 4990 P BTO 1.00", margin: 10_000, pl: -5000 }),
    ];
    const r = simulate(toSimTrades(trades), { PS: { pct: 10 } }, 100_000);
    // Day 1: 10% of 100k / 1,000 = 10 contracts → +2,000. Day 2: 10% of 102k → 10 contracts → −5,000.
    expect(r.trades).toBe(2);
    expect(r.pl).toBe(-3000);
    expect(r.maxDd).toBe(-5000);
    expect(r.maxDdPct).toBeCloseTo(-5000 / 102_000);
    expect(r.winPct).toBe(0.5);
    expect(r.profitFactor).toBeCloseTo(0.4);
    expect(r.months).toEqual([{ month: "2026-03", pl: -3000, pct: -0.03 }]);
    expect(r.avgMarginUtil).toBeCloseTo((10_000 / 100_000 + 10_000 / 102_000) / 2);
    expect(r.strategies[0]).toMatchObject({ strategy: "PS", trades: 2, contribution: 1, tradeShare: 1 });
  });

  it("caps contracts and skips strategies set to 0%", () => {
    const trades = [t({ margin: 10_000 }), t({ strategy: "Off", margin: 10_000 })];
    const r = simulate(toSimTrades(trades), { PS: { pct: 50, maxContracts: 3 }, Off: { pct: 0 } }, 100_000);
    expect(r.trades).toBe(1);
    expect(r.pl).toBe(600);
  });

  it("infers OO's sizing, including a contract cap", () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      t({ dateOpened: `2026-03-0${i}`, dateClosed: `2026-03-0${i}`, contracts: 50, margin: 50_000, fundsAtClose: 4_000_000 + 2000, pl: 2000 }),
    );
    rows.push(t({ dateOpened: "2026-03-09", dateClosed: "2026-03-09", contracts: 40, margin: 40_000, fundsAtClose: 400_000 + 2000, pl: 2000 }));
    expect(impliedAllocations(rows).PS).toEqual({ pct: 10, maxContracts: 50 });
  });
});

describe("duplicate runs", () => {
  it("counts an entry once when two OO runs of it are stored", () => {
    const a = t({ margin: 10_000, pl: 2000, contracts: 10 });
    const b = t({ margin: 7_000, pl: 1400, contracts: 7, legs: "7 Mar 2 5000 P STO 3.00 | 7 Mar 2 4990 P BTO 1.00", strategy: "PS " });
    const r = simulate(toSimTrades([a, b]), { PS: { pct: 10 } }, 100_000);
    expect(r.trades).toBe(1);
  });
});
