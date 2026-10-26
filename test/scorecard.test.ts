import { describe, expect, it } from "vitest";
import type { OOTrade } from "@/lib/ooCsv";
import { parseLegs } from "@/lib/ooCsv";
import { normalizeTransactions, type SchwabTransaction } from "@/lib/realized";
import { aggregate, buildLiveTrades, buildScorecard, canonicalStrategy, EXPECTED, scoreTrades, toBacktest } from "@/lib/scorecard";

const SCHWAB_FEE = 1.13; // per contract, as Schwab reports it (reference implies $4.52 per IC)
const sym = (exp: string, pc: "P" | "C", k: number) => `SPXW  ${exp.slice(2).replace(/-/g, "")}${pc}${String(k * 1000).padStart(8, "0")}`;
let id = 0;

/** One Schwab transaction per leg, sharing an orderId. */
function order(orderId: number, timeIso: string, legs: [string, number, number][], effect: "OPENING" | "CLOSING", fee = SCHWAB_FEE): SchwabTransaction[] {
  return legs.map(([symbol, amount, price]) => {
    const cost = -amount * price * 100;
    const f = fee * Math.abs(amount);
    return {
      activityId: ++id, time: timeIso, type: "TRADE", orderId, netAmount: cost - f,
      transferItems: [
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, cost: -f, feeType: "COMMISSION" },
        { instrument: { assetType: "OPTION", symbol }, amount, price, cost, positionEffect: effect },
      ],
    };
  });
}

/** Overnight cash settlement rows (posted ~01:47 ET next day) at the given per-share value. */
function settle(timeIso: string, legs: [string, number, number][]): SchwabTransaction[] {
  return legs.map(([symbol, amount, price]) => ({
    activityId: ++id, time: timeIso, type: "TRADE", orderId: ++id, netAmount: -amount * price * 100,
    transferItems: [{ instrument: { assetType: "OPTION", symbol }, amount, price, cost: -amount * price * 100, positionEffect: "CLOSING" }],
  }));
}

const bt = (o: Partial<OOTrade> & Pick<OOTrade, "dateOpened" | "timeOpened" | "legs" | "premium" | "pl" | "contracts">): OOTrade => ({
  key: `${o.strategy ?? "5d"}|${o.dateOpened}|${o.timeOpened}`,
  strategy: "! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300",
  dateClosed: o.dateOpened, timeClosed: "16:00:00", reason: "Expired", fundsAtClose: null, openFees: 0, closeFees: 0,
  ...o,
});

const D = "2026-10-16";
const ic = (p1: number, c1: number, p2: number, c2: number, px: [number, number, number, number], qty = 18): [string, number, number][] => [
  [sym(D, "P", p1), -qty, px[0]], [sym(D, "C", c1), -qty, px[1]], [sym(D, "P", p2), qty, px[2]], [sym(D, "C", c2), qty, px[3]],
];
const expire = (legs: [string, number, number][]): [string, number, number][] => legs.map(([s, q]) => [s, -q, 0]);

// Reference: 5d IC on 2026-10-16. Backtest fees $2.60 per IC (implied by $117.40 = $120 − $2.60).
const e1 = ic(7600, 7725, 7500, 7825, [0.85, 0.7, 0.25, 0.1]); // credit 1.20
const e2 = ic(7590, 7695, 7490, 7795, [0.8, 0.7, 0.25, 0.1]); // credit 1.15
const fills = normalizeTransactions(
  [
    ...order(101, "2026-10-16T17:30:04+0000", e1, "OPENING"),
    ...order(102, "2026-10-16T18:30:06+0000", e2, "OPENING"),
    ...settle("2026-10-17T05:47:50+0000", [...expire(e1), ...expire(e2)]),
  ],
  0.88,
);
const backtest: OOTrade[] = [
  bt({ dateOpened: D, timeOpened: "13:30:00", premium: 120, pl: (120 - 2.6) * 26, contracts: 26, openFees: 2.6 * 26,
    legs: "26 Oct 16 7600 P STO 0.85 | 26 Oct 16 7725 C STO 0.70 | 26 Oct 16 7500 P BTO 0.20 | 26 Oct 16 7825 C BTO 0.10" }),
  bt({ dateOpened: D, timeOpened: "14:30:00", premium: 110, pl: (110 - 2.6) * 26, contracts: 26, openFees: 2.6 * 26,
    legs: "26 Oct 16 7590 P STO 0.75 | 26 Oct 16 7695 C STO 0.70 | 26 Oct 16 7490 P BTO 0.20 | 26 Oct 16 7795 C BTO 0.10" }),
];

describe("reference: 5d IC 2026-10-16", () => {
  const [t1, t2] = scoreTrades(buildLiveTrades(fills, D), backtest.map((b) => toBacktest(b)!), D, D).sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  it("13:30 — filled $1.20 vs $1.20, expired, $115.48 vs $117.40 (fees only)", () => {
    expect(t1.status).toBe("matched");
    expect(t1.strategy).toBe("5d IC");
    expect(t1.live!.credit).toBeCloseTo(1.2, 4);
    expect(t1.bt!.credit).toBeCloseTo(1.2, 4);
    expect(t1.entrySlip).toBeCloseTo(0, 4);
    expect(t1.category).toBe("expired");
    expect(t1.exitSlip).toBeCloseTo(0, 4);
    expect(t1.live!.plPerCt).toBeCloseTo(115.48, 2);
    expect(t1.bt!.plPerCt).toBeCloseTo(117.4, 2);
    expect(t1.plDiffPerCt).toBeCloseTo(-1.92, 2);
    expect(t1.feePerSide).toBeCloseTo(1.13, 4);
    expect(t1.flags).toEqual([]);
  });

  it("14:30 — filled $1.15 vs $1.10 (better), expired, $110.48 vs $107.40", () => {
    expect(t2.entrySlip).toBeCloseTo(-0.05, 4);
    expect(t2.live!.plPerCt).toBeCloseTo(110.48, 2);
    expect(t2.bt!.plPerCt).toBeCloseTo(107.4, 2);
    expect(t2.plDiffPerCt).toBeCloseTo(3.08, 2);
  });
});

describe("stops, flags, missed/extra/awaiting", () => {
  const D2 = "2026-10-20";
  const icD2 = (p1: number, c1: number, p2: number, c2: number, px: [number, number, number, number]): [string, number, number][] => [
    [sym(D2, "P", p1), -10, px[0]], [sym(D2, "C", c1), -10, px[1]], [sym(D2, "P", p2), 10, px[2]], [sym(D2, "C", c2), 10, px[3]],
  ];
  const open = icD2(7600, 7700, 7500, 7800, [1, 0.8, 0.2, 0.1]); // 1.50 credit
  // Stopped at 15:56 ET (19:56Z): buy back shorts 3.10/0.30, sell wings 0.05/0.05 -> debit 3.30
  const close: [string, number, number][] = [[open[0][0], 10, 3.1], [open[1][0], 10, 0.3], [open[2][0], -10, 0.05], [open[3][0], -10, 0.05]];
  const f2 = normalizeTransactions(
    [
      ...order(201, "2026-10-20T17:30:02+0000", open, "OPENING"),
      ...order(202, "2026-10-20T19:56:10+0000", close, "CLOSING"),
      ...order(203, "2026-10-20T15:00:00+0000", icD2(7650, 7750, 7550, 7850, [0.5, 0.5, 0.1, 0.1]), "OPENING"), // no backtest twin
    ],
    0.88,
  );
  const btD2 = [
    // Backtest stop: credit 1.55, debit 2.20 (P/L = (1.55 − 2.20)×100×10 − fees 20)
    bt({ dateOpened: D2, timeOpened: "13:30:00", premium: 155, pl: (1.55 - 2.2) * 1000 - 20, contracts: 10, openFees: 10, closeFees: 10,
      reason: "Stop Loss", timeClosed: "15:56:00", legs: "10 Oct 20 7600 P STO 1.05 | 10 Oct 20 7700 C STO 0.85 | 10 Oct 20 7500 P BTO 0.20 | 10 Oct 20 7800 C BTO 0.10" }),
    bt({ dateOpened: D2, timeOpened: "14:30:00", premium: 100, pl: 900, contracts: 10, legs: "10 Oct 20 7610 P STO 0.70 | 10 Oct 20 7690 C STO 0.60 | 10 Oct 20 7510 P BTO 0.10 | 10 Oct 20 7790 C BTO 0.10" }),
  ].map((b) => toBacktest(b)!);
  const later = order(301, "2026-10-21T17:30:00+0000", ic(7600, 7700, 7500, 7800, [1, 1, 0.2, 0.2]).map(([s, q, p]) => [s.replace("261016", "261021"), q, p]), "OPENING");
  const rows = scoreTrades(buildLiveTrades([...f2, ...normalizeTransactions(later, 0.88)], D2), btD2, D2, D2);
  const stopRow = rows.find((r) => r.live?.orderId === "201")!;

  it("measures stop slippage as live debit − backtest debit and flags late stops", () => {
    expect(stopRow.category).toBe("stop");
    expect(stopRow.entrySlip).toBeCloseTo(0.05, 4);
    expect(stopRow.live!.debit).toBeCloseTo(3.3, 4);
    expect(stopRow.bt!.debit).toBeCloseTo(2.2, 4);
    expect(stopRow.exitSlip).toBeCloseTo(1.1, 4);
    expect(stopRow.flags).toContain("Stop filled ≥ 15:55 ET");
    expect(stopRow.flags).toContain("Exit ≥ $1.00 worse than backtest");
  });

  it("classifies extra, missed and awaiting-backtest trades", () => {
    expect(rows.find((r) => r.live?.orderId === "203")!.status).toBe("extra");
    expect(rows.filter((r) => r.status === "missed").map((r) => r.entryTime)).toEqual(["14:30:00"]);
    expect(rows.find((r) => r.live?.orderId === "301")!.status).toBe("awaiting");
  });

  it("aggregates slippage, cost and lights", () => {
    const a = aggregate("5d IC", rows.filter((r) => r.strategy === "5d IC"), (s) => EXPECTED[s]);
    expect(a.stop.n).toBe(1);
    expect(a.stop.mean).toBeCloseTo(110, 2); // $/contract
    expect(a.slippageCost).toBeCloseTo((0.05 + 1.1) * 100 * 10, 2);
    expect(a.lights.slippage).toBe("red"); // flagged fill
    expect(a.lights.stopRate).toBe("few");
    expect(a.lights.missedExtra).toBe("yellow");
  });
});

describe("helpers", () => {
  it("maps OO names to the book's strategies", () => {
    expect(canonicalStrategy("! SPX 0 DTE - Long (sell puts) +costs")).toBe("Long");
    expect(canonicalStrategy("! SPX 0 DTE - Short (sell calls) RE-TUNED +costs")).toBe("Short");
    expect(canonicalStrategy("! SPX 0 DTE 8SMA IC +costs")).toBe("8SMA IC");
    expect(canonicalStrategy("! SPX 0DTE $8 IC 1:35 10SMA")).toBe("$8 IC");
    expect(canonicalStrategy("! SPX 0DTE $8 IC 1:35 10SMA - Dip Add-On")).toBe("$8 IC");
    expect(canonicalStrategy("! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300")).toBe("5d IC");
    expect(canonicalStrategy("! SPX 0DTE Put BWB Fly - 3 Entries Above 5SMA")).toBe("BWB");
    expect(canonicalStrategy("! SPX 2DTE Down-Trend Put Spread - 11D 75w (tested)")).toBe("2DTE");
  });

  it("parses OO legs", () => {
    expect(parseLegs("26 Oct 16 7600 P STO 0.85 | 26 Oct 16 7500 P BTO 0.20", "2026-10-16")).toEqual([
      { qty: -26, putCall: "P", strike: 7600, expiration: "2026-10-16", price: 0.85 },
      { qty: 26, putCall: "P", strike: 7500, expiration: "2026-10-16", price: 0.2 },
    ]);
  });

  it("builds a full scorecard with MTD and since-inception periods", () => {
    const sc = buildScorecard(fills, backtest, D, Date.parse("2026-10-25T15:00:00Z"));
    expect(sc.coverageEnd).toBe(D);
    expect(sc.periods.inception.book.liveTrades).toBe(2);
    expect(sc.periods.inception.strategies.find((s) => s.name === "5d IC")!.matchedClosed).toBe(2);
    expect(sc.periods.mtd.book.liveTrades).toBe(2);
  });
});

describe("inferStrategy", () => {
  const mk = (strategy: string, time: string, premium: number, legs: string) =>
    toBacktest(bt({ strategy, dateOpened: "2026-09-01", timeOpened: time, premium, pl: 100, contracts: 10, legs }))!;
  const icLegs = "10 Sep 1 7600 P STO 1 | 10 Sep 1 7700 C STO 1 | 10 Sep 1 7500 P BTO 0.1 | 10 Sep 1 7800 C BTO 0.1";
  const history = [
    mk("! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300", "13:30:00", 80, icLegs),
    mk("! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300", "14:30:00", 120, icLegs),
    mk("! SPX 0 DTE 8SMA IC +costs", "13:30:00", 850, icLegs),
    mk("! SPX 0DTE $8 IC 1:35 10SMA", "13:35:00", 1500, icLegs),
  ];
  const D3 = "2026-10-22";
  const live = (orderId: number, iso: string, px: [number, number, number, number]) =>
    buildLiveTrades(normalizeTransactions(order(orderId, iso, [
      [sym(D3, "P", 7600), -9, px[0]], [sym(D3, "C", 7700), -9, px[1]], [sym(D3, "P", 7500), 9, px[2]], [sym(D3, "C", 7800), 9, px[3]],
    ], "OPENING"), 0.88), D3)[0];
  const rows = scoreTrades(
    [live(1, "2026-10-22T17:30:03+0000", [0.6, 0.5, 0.05, 0.05]), live(2, "2026-10-22T17:30:05+0000", [5, 4, 0.5, 0.4]), live(3, "2026-10-22T17:35:12+0000", [8, 7.5, 0.3, 0.2])],
    history, D3, "2026-10-21",
  );
  it("tells 5d IC, 8SMA IC and $8 IC apart by time and credit", () => {
    const byOrder = Object.fromEntries(rows.map((r) => [r.live!.orderId, r]));
    expect(byOrder["1"].strategy).toBe("5d IC");
    expect(byOrder["2"].strategy).toBe("8SMA IC");
    expect(byOrder["3"].strategy).toBe("$8 IC");
    expect(rows.every((r) => r.strategyInferred && r.status === "awaiting")).toBe(true);
  });
});

describe("fixes: shared-strike exits, multi-day extras, pre-live missed, fees, stop-rate weighting", () => {
  const D4 = "2026-10-21";
  const S4 = (pc: "P" | "C", k: number) => sym(D4, pc, k);

  it("attributes a closing order to the entry it matches, not FIFO by symbol (#7)", () => {
    // $8 IC opened 13:35 (short 6× 7765P); BWB opened 13:50 (short 18× 7765P).
    // The BWB's stop (14:05) buys back 18× 7765P first; the IC's own stop (15:10) closes its 4 legs.
    const icLegs: [string, number, number][] = [[S4("P", 7765), -6, 6.62], [S4("C", 7760), -6, 6.77], [S4("P", 7715), 6, 0.27], [S4("C", 7810), 6, 0.07]];
    const bwbLegs: [string, number, number][] = [[S4("P", 7795), 9, 29.03], [S4("P", 7765), -18, 4.35], [S4("P", 7720), 9, 0.22]];
    const bwbStop: [string, number, number][] = [[S4("P", 7795), -9, 35], [S4("P", 7765), 18, 9], [S4("P", 7720), -9, 0.3]];
    const icStop: [string, number, number][] = [[S4("P", 7765), 6, 20], [S4("C", 7760), 6, 10.6], [S4("P", 7715), -6, 1.5], [S4("C", 7810), -6, 0.5]];
    const f = normalizeTransactions(
      [
        ...order(401, "2026-10-21T17:35:12+0000", icLegs, "OPENING"),
        ...order(402, "2026-10-21T17:50:10+0000", bwbLegs, "OPENING"),
        ...order(403, "2026-10-21T18:05:00+0000", bwbStop, "CLOSING"),
        ...order(404, "2026-10-21T19:10:00+0000", icStop, "CLOSING"),
      ],
      0.88,
    );
    const [ic, bwb] = buildLiveTrades(f, D4);
    expect(ic.orderId).toBe("401");
    expect(new Set(ic.exits.map((x) => x.orderId))).toEqual(new Set(["404"]));
    expect(ic.exits.reduce((s, x) => s + x.qty, 0)).toBe(24); // all 4 legs, full quantity
    expect(ic.debit).toBeCloseTo(20 + 10.6 - 1.5 - 0.5, 4);
    expect(new Set(bwb.exits.map((x) => x.orderId))).toEqual(new Set(["403"]));
  });

  it("does not flag a multi-day trade as extra before the log covers its expiration (#3)", () => {
    const t = normalizeTransactions(
      order(501, "2026-10-19T19:30:04+0000", [[sym("2026-10-21", "P", 7585), -11, 5.2], [sym("2026-10-21", "P", 7510), 11, 2.3]], "OPENING"),
      0.88,
    );
    const [row] = scoreTrades(buildLiveTrades(t, "2026-10-19"), [], "2026-10-19", "2026-10-19");
    expect(row.status).toBe("awaiting");
    const [later] = scoreTrades(buildLiveTrades(t, "2026-10-19"), [], "2026-10-19", "2026-10-21");
    expect(later.status).toBe("extra");
  });

  it("only counts missed entries from the first day with Schwab fills (#2)", () => {
    const lateFills = normalizeTransactions(order(601, "2026-10-19T17:30:02+0000", ic(7600, 7700, 7500, 7800, [1, 1, 0.2, 0.2]).map(([s, q, p]) => [s.replace("261016", "261019"), q, p]), "OPENING"), 0.88);
    const sc = buildScorecard(lateFills, backtest, "2026-10-16", Date.parse("2026-10-25T15:00:00Z"));
    expect(sc.firstLiveDay).toBe("2026-10-19");
    expect(sc.trades.filter((t) => t.status === "missed")).toHaveLength(0);
  });

  it("lights fees against $0.88/side and reports the $ excess (#4)", () => {
    const a = aggregate("5d IC", scoreTrades(buildLiveTrades(fills, D), backtest.map((b) => toBacktest(b)!), D, D), (s) => EXPECTED[s]);
    expect(a.feePerSide).toBeCloseTo(1.13, 4);
    expect(a.lights.fees).toBe("red"); // +28%
    expect(a.feeExcess).toBeCloseTo((1.13 - 0.88) * 144, 2); // 2 ICs × 4 legs × 18 contracts, opening side only
  });

  it("book stop rate uses only strategies with 10+ trades, trade-weighted (#5)", () => {
    // 12 expired 5d ICs (0 stops) + 3 Long trades stopped: Long has too few trades to count.
    const days = Array.from({ length: 12 }, (_, i) => `2026-10-${String(1 + i).padStart(2, "0")}`);
    const tx: SchwabTransaction[] = [];
    const bts: OOTrade[] = [];
    days.forEach((d, i) => {
      const legs: [string, number, number][] = [[sym(d, "P", 7600), -1, 0.6], [sym(d, "C", 7700), -1, 0.5], [sym(d, "P", 7500), 1, 0.05], [sym(d, "C", 7800), 1, 0.05]];
      tx.push(...order(700 + i, `${d}T17:30:00+0000`, legs, "OPENING"));
      tx.push(...settle(`${d}T21:00:00+0000`, legs.map(([s, q]) => [s, -q, 0])));
      const md = `Oct ${Number(d.slice(8))}`;
      bts.push(bt({ dateOpened: d, timeOpened: "13:30:00", premium: 100, pl: 100, contracts: 1,
        legs: `1 ${md} 7600 P STO 0.6 | 1 ${md} 7700 C STO 0.5 | 1 ${md} 7500 P BTO 0.05 | 1 ${md} 7800 C BTO 0.05` }));
    });
    days.slice(0, 3).forEach((d, i) => {
      const legs: [string, number, number][] = [[sym(d, "P", 7700), -1, 6], [sym(d, "P", 7600), 1, 0.3]];
      tx.push(...order(800 + i, `${d}T15:00:00+0000`, legs, "OPENING"));
      tx.push(...order(900 + i, `${d}T17:00:00+0000`, [[legs[0][0], 1, 15], [legs[1][0], -1, 1]], "CLOSING"));
      const md = `Oct ${Number(d.slice(8))}`;
      bts.push(bt({ strategy: "! SPX 0 DTE - Long (sell puts) +costs", dateOpened: d, timeOpened: "11:00:00", premium: 570, pl: -900, contracts: 1,
        reason: "Stop Loss", legs: `1 ${md} 7700 P STO 6 | 1 ${md} 7600 P BTO 0.3` }));
    });
    const sc = buildScorecard(normalizeTransactions(tx, 0.88), bts, "2026-10-01", Date.parse("2026-10-20T15:00:00Z"));
    const p = sc.periods.inception;
    expect(p.qualifyingForStops).toEqual(["5d IC"]);
    expect(p.book.stopRateRolling20).toBe(0);
    expect(p.book.expectedStopRate).toBeCloseTo(0.11, 6);
    expect(p.book.lights.stopRate).toBe("green");
    expect(p.strategies.find((s) => s.name === "Long")!.lights.stopRate).toBe("few");
  });
});
