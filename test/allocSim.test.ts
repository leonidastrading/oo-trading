import { describe, expect, it } from "vitest";
import { impliedAllocations, maxLossPerLot, optimizeBoosts, simulate, toSimTrades, uniqueEntries } from "@/lib/allocSim";
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
    expect(r.months).toEqual([{ month: "2026-03", pl: -3000, pct: -0.03, hiPct: 0.02, loPct: -0.03, vix: null }]);
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
    // 10% of $1M, capped at 50 contracts: cheap entries ($1,000/lot) hit the cap; a $4,000/lot entry gets 25.
    const rows = [1, 2, 3, 4, 5].map((i) =>
      t({ dateOpened: `2026-03-0${i}`, dateClosed: `2026-03-0${i}`, contracts: 50, margin: 50_000, fundsAtClose: 1_000_000, pl: 0 }),
    );
    rows.push(t({ dateOpened: "2026-03-09", dateClosed: "2026-03-09", contracts: 25, margin: 100_000, fundsAtClose: 1_000_000, pl: 0 }));
    expect(impliedAllocations(rows).PS).toEqual({ pct: 10, maxContracts: 50 });
  });

  it("reads funds at entry from the log's running P/L", () => {
    // Starts at $100k; the first trade makes $10k, so the second (7.2% of $110k at $1,000/lot) gets 7 contracts.
    const a = t({ dateOpened: "2026-03-02", dateClosed: "2026-03-02", contracts: 7, margin: 7_000, fundsAtClose: 110_000, pl: 10_000 });
    const b = t({ dateOpened: "2026-03-03", dateClosed: "2026-03-03", contracts: 7, margin: 7_000, fundsAtClose: 110_500, pl: 500 });
    expect(impliedAllocations([a, b]).PS.pct).toBe(7);
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

describe("mixed runs", () => {
  it("keeps the newest copy of an entry and reads sizing from one run per strategy", () => {
    const old = t({ margin: 10_000, pl: 2000, contracts: 10, uploadedAt: 1, source: "a" });
    const fresh = t({ margin: 7_000, pl: 1400, contracts: 7, legs: "7 Mar 2 5000 P STO 3.00 | 7 Mar 2 4990 P BTO 1.00", uploadedAt: 2, source: "b" });
    const r = simulate(toSimTrades([old, fresh]), { PS: { pct: 7 } }, 100_000);
    expect(r.trades).toBe(1);
    const sized = [1, 2, 3].map((i) => t({ dateOpened: `2026-03-0${i}`, source: "csv", margin: 10_000, contracts: 10, fundsAtClose: 100_000 + 2000 }));
    const other = [4, 5, 6, 7].map((i) => t({ dateOpened: `2026-03-0${i}`, source: i === 4 ? "x" : `feed${i}`, margin: 50_000, contracts: 50, fundsAtClose: 100_000 + 2000 }));
    expect(impliedAllocations([...sized, ...other]).PS).toMatchObject({ pct: 10 });
  });
});

describe("portfolio settings", () => {
  it("maps every Schwab Port 2026 strategy to its OO allocation", async () => {
    const { portfolioAlloc } = await import("@/lib/allocSim");
    expect(portfolioAlloc("! SPX 0 DTE - Long (sell puts) +costs")).toEqual({ pct: 7.2 });
    expect(portfolioAlloc("! SPX 0 DTE - Short (sell calls) RE-TUNED +costs")).toEqual({ pct: 3.4 });
    expect(portfolioAlloc("! SPX 0 DTE 8SMA IC +costs")).toEqual({ pct: 5.4 });
    expect(portfolioAlloc("! SPX 0DTE - FOMC 2:35pm long straddle 0.5%")).toEqual({ pct: 0.5 });
    expect(portfolioAlloc("! SPX 0DTE $8 IC 1:35 10SMA")).toEqual({ pct: 0.9 });
    expect(portfolioAlloc("! SPX 0DTE $8 IC 1:35 10SMA - Dip Add-On")).toEqual({ pct: 100, maxContracts: 1 });
    expect(portfolioAlloc("! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300")).toEqual({ pct: 3 });
    expect(portfolioAlloc("! SPX 0DTE Put BWB Fly - 3 Entries Above 5SMA")).toEqual({ pct: 0.5 });
    expect(portfolioAlloc("! SPX 1DTE Vix >30 1:30pm")).toEqual({ pct: 2 });
    expect(portfolioAlloc("! SPX 1DTE VIX up ≥5% 1DTE put spread 3:50pm")).toEqual({ pct: 1 });
    expect(portfolioAlloc("! SPX 2DTE Down-Trend Put Spread - 11D 75w (tested)")).toEqual({ pct: 3 });
  });
});

describe("optimizer", () => {
  const days = Array.from({ length: 20 }, (_, i) => `2026-04-${String(i + 1).padStart(2, "0")}`);
  // A steady winner and a volatile loser-ish strategy.
  const good = days.map((d, i) => t({ strategy: "Good", dateOpened: d, dateClosed: d, margin: 10_000, contracts: 10, pl: i % 5 === 0 ? -500 : 400 }));
  const bad = days.map((d, i) => t({ strategy: "Bad", dateOpened: d, dateClosed: d, margin: 10_000, contracts: 10, pl: i % 2 ? -900 : 800 }));
  const sims = toSimTrades([...good, ...bad]);

  it("raises the winner, drops the loser and respects the margin limit", async () => {
    const { optimize } = await import("@/lib/allocSim");
    const r = await optimize(sims, { Good: { pct: 2 }, Bad: { pct: 2 } }, 100_000, {
      objective: "pl",
      include: ["Good", "Bad"],
      maxAvgMargin: 0.1,
      maxPeakMargin: null,
      maxDrawdown: null,
    });
    expect(r.feasible).toBe(true);
    expect(r.alloc.Bad.pct).toBe(0);
    expect(r.alloc.Good.pct).toBeGreaterThan(2);
    expect(r.result.avgMarginUtil).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("leaves unchecked strategies alone", async () => {
    const { optimize } = await import("@/lib/allocSim");
    const r = await optimize(sims, { Good: { pct: 2 }, Bad: { pct: 2 } }, 100_000, {
      objective: "pl",
      include: ["Good"],
      maxAvgMargin: null,
      maxPeakMargin: null,
      maxDrawdown: null,
    });
    expect(r.alloc.Bad.pct).toBe(2);
  });
});

describe("leftover rows", () => {
  it("drops untagged rows of a strategy that has a tagged upload", () => {
    const fresh = t({ source: "log.csv", uploadedAt: 5, margin: 10_000 });
    const stale = t({ dateOpened: "2026-03-31", dateClosed: "2026-03-31", margin: 10_000 });
    const other = t({ strategy: "Other", margin: 10_000 });
    const names = uniqueEntries([fresh, stale, other]).map((x) => `${x.strategy}|${x.dateOpened}`);
    expect(names.sort()).toEqual(["Other|2026-03-02", "PS|2026-03-02"]);
  });
});

describe("fixed lots", () => {
  it("sizes every trade at a fixed number of contracts, ignoring the log's sizing", () => {
    const trades = [t({ margin: 10_000, pl: 2000, contracts: 10 }), t({ dateOpened: "2026-03-03", dateClosed: "2026-03-03", margin: 50_000, pl: -5000, contracts: 50 })];
    const r = simulate(toSimTrades(trades), { PS: { pct: 0, fixed: 2 } }, 100_000);
    expect(r.trades).toBe(2);
    expect(r.pl).toBe(2 * 200 - 2 * 100);
  });

  it("optimizes lot counts", async () => {
    const { optimize } = await import("@/lib/allocSim");
    const days = Array.from({ length: 10 }, (_, i) => `2026-04-${String(i + 1).padStart(2, "0")}`);
    const good = days.map((d) => t({ strategy: "Good", dateOpened: d, dateClosed: d, margin: 1000, contracts: 1, pl: 100 }));
    const bad = days.map((d) => t({ strategy: "Bad", dateOpened: d, dateClosed: d, margin: 1000, contracts: 1, pl: -50 }));
    const r = await optimize(toSimTrades([...good, ...bad]), { Good: { pct: 0, fixed: 1 }, Bad: { pct: 0, fixed: 1 } }, 100_000, {
      objective: "pl",
      include: ["Good", "Bad"],
      maxAvgMargin: 0.05,
      maxPeakMargin: null,
      maxDrawdown: null,
    });
    expect(r.alloc.Bad.fixed).toBe(0);
    expect(r.alloc.Good.fixed).toBeGreaterThan(1);
    expect(r.result.avgMarginUtil).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});

describe("double after a stop-out", () => {
  it("doubles only the very next trade after a stop", () => {
    const day = (d: string, pl: number, reason: string) =>
      t({ dateOpened: d, dateClosed: d, legs: `10 Mar ${Number(d.slice(-2))} 5000 P STO 3.00 | 10 Mar ${Number(d.slice(-2))} 4990 P BTO 1.00`, margin: 10_000, pl, reason });
    const trades = [day("2026-03-02", -1000, "Stop Loss"), day("2026-03-03", 2000, "Expired"), day("2026-03-04", 2000, "Expired")];
    const base = simulate(toSimTrades(trades), { PS: { pct: 0, fixed: 1 } }, 100_000);
    const dbl = simulate(toSimTrades(trades), { PS: { pct: 0, fixed: 1, doubleAfterStop: true } }, 100_000);
    expect(base.pl).toBe(-100 + 200 + 200);
    expect(dbl.pl).toBe(-100 + 400 + 200);
  });
});

describe("VIX safe zone", () => {
  it("skips entries outside a strategy's VIX range and keeps ones without a reading", () => {
    const day = (d: string, vix: number | null) =>
      t({ dateOpened: d, dateClosed: d, legs: `10 Mar ${Number(d.slice(-2))} 5000 P STO 3.00 | 10 Mar ${Number(d.slice(-2))} 4990 P BTO 1.00`, margin: 10_000, pl: 1000, vix });
    const trades = [day("2026-03-02", 12), day("2026-03-03", 18), day("2026-03-04", 30), day("2026-03-05", null)];
    const r = simulate(toSimTrades(trades), { PS: { pct: 0, fixed: 1, vixMin: 15, vixMax: 25 } }, 100_000);
    expect(r.trades).toBe(2);
    expect(r.vixSkipped).toEqual({ PS: 2 });
  });
});

describe("optimizer VIX ranges", () => {
  it("finds a VIX ceiling that drops the losing high-VIX trades", async () => {
    const { optimize } = await import("@/lib/allocSim");
    const days = Array.from({ length: 12 }, (_, i) => `2026-04-${String(i + 1).padStart(2, "0")}`);
    const trades = days.map((d, i) =>
      t({ dateOpened: d, dateClosed: d, legs: `1 Apr ${i + 1} 5000 P STO 3.00 | 1 Apr ${i + 1} 4990 P BTO 1.00`, contracts: 1, margin: 1000, vix: i % 3 === 0 ? 32 : 15, pl: i % 3 === 0 ? -400 : 100 }),
    );
    const r = await optimize(toSimTrades(trades), { PS: { pct: 0, fixed: 1 } }, 100_000, {
      objective: "pl",
      include: ["PS"],
      maxAvgMargin: null,
      maxPeakMargin: null,
      maxDrawdown: null,
      maxLots: 1,
      optimizeVix: true,
    });
    expect(r.alloc.PS.vixMax).toBeDefined();
    expect(r.alloc.PS.vixMax!).toBeLessThan(32);
    expect(r.result.pl).toBe(8 * 100);
    expect(r.alloc.PS.fixed).toBe(1); // sizes untouched in VIX mode
  });
});

describe("streak boost", () => {
  // One trade a day, $1,000 risk per lot; a stop loses $500/lot, a winner makes $100/lot.
  const day = (i: number) => `2026-03-${String(i + 1).padStart(2, "0")}`;
  const mk = (i: number, kind: "stop" | "loss" | "win") => ({
    strategy: "S",
    open: `${day(i)} 10:00:00`,
    close: `${day(i)} 15:00:00`,
    closeDate: day(i),
    plPerLot: kind === "win" ? 100 : -500,
    riskPerLot: 1000,
    premiumPerLot: 100,
    stopped: kind === "stop",
    vix: null,
  });
  it("sizes up after N stops in a row until a winner", () => {
    const seq = ["stop", "stop", "stop", "loss", "stop", "win", "win"] as const;
    const trades = seq.map((k, i) => mk(i, k));
    const base = simulate(trades, { S: { pct: 1, fixed: 10 } }, 100_000);
    const up = simulate(trades, { S: { pct: 1, fixed: 10, boost: { kind: "stop", after: 2, mult: 2 } } }, 100_000);
    // Trades 3 (after 2 stops), 4 (the non-stop loss keeps the streak), 5 and 6 (the first winner) are doubled; 7 is back to normal.
    expect(up.boosted).toBe(4);
    expect(up.pl - base.pl).toBe(10 * (-500 - 500 - 500 + 100));
    const losses = simulate(trades, { S: { pct: 1, fixed: 10, boost: { kind: "loss", after: 4, mult: 3 } } }, 100_000);
    expect(losses.boosted).toBe(2); // after the 4th loss in a row: trade 5 (stop) and 6 (winner)
  });
});

describe("streak boost optimizer", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  // After two stops the next trade always wins: sizing up after 2 stops can only help P/L.
  const kinds = ["stop", "stop", "win", "win", "win"] as const;
  const trades = Array.from({ length: 40 }, (_, i) => {
    const k = kinds[i % kinds.length];
    return {
      strategy: "S",
      open: `${day(i)} 10:00:00`,
      close: `${day(i)} 15:00:00`,
      closeDate: day(i),
      plPerLot: k === "win" ? 300 : -200,
      riskPerLot: 1000,
      premiumPerLot: 300,
      stopped: k === "stop",
      vix: null,
    };
  });
  it("finds a rule that sizes up the trade after the streak", async () => {
    const r = await optimizeBoosts(trades, { S: { pct: 1, fixed: 1 } }, 100_000, { objective: "pl", kinds: ["stop"], include: ["S"], maxDrawdown: null });
    expect(r.boosts.S).toEqual({ kind: "stop", after: 2, mult: 4 });
    expect(r.result.pl).toBeGreaterThan(simulate(trades, { S: { pct: 1, fixed: 1 } }, 100_000).pl);
  });
  it("respects the margin cap", async () => {
    // 1 lot = $1,000 of margin on $100k (1%); a 1.5% cap allows no sizing up at all, 2.5% allows 2x.
    const o = { objective: "pl" as const, kinds: ["stop" as const], include: ["S"], maxDrawdown: null };
    expect((await optimizeBoosts(trades, { S: { pct: 1, fixed: 1 } }, 100_000, { ...o, maxPeakMargin: 0.015 })).boosts.S).toBeNull();
    const r = await optimizeBoosts(trades, { S: { pct: 1, fixed: 1 } }, 100_000, { ...o, maxPeakMargin: 0.025 });
    expect(r.boosts.S?.mult).toBe(2);
    expect(r.result.maxMarginUtil).toBeLessThanOrEqual(0.025);
  });
});
