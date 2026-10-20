import { describe, expect, it } from "vitest";
import { parseCsv, parseOOTradeLog } from "@/lib/ooCsv";

const HEADER =
  '"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","P/L %","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees"';

const row = (o: Partial<Record<string, string>> = {}) =>
  [
    o.dateOpened ?? "2026-10-20",
    o.timeOpened ?? "10:30:00",
    "7718.5",
    o.legs ?? "18 Oct 20 7680 P STO 0.41 | 18 Oct 20 7755 C STO 0.41",
    o.premium ?? "1260",
    "7722",
    o.dateClosed ?? "2026-10-20",
    "16:00:00",
    "0",
    o.reason ?? "Expired",
    o.pl ?? "1,106.00",
    "94.6",
    o.contracts ?? "18",
    "150000",
    "180000",
    o.strategy ?? "SPX 0DTE 5d IC 100-wide",
    "23.4",
    "0",
  ]
    .map((v) => `"${v.replace(/"/g, '""')}"`)
    .join(",");

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n')).toEqual([
      ["a", "b,c", 'd "e"'],
      ["1", "2", "3"],
    ]);
  });
  it("strips a BOM and skips blank lines", () => {
    expect(parseCsv("﻿x,y\n\n1,2")).toEqual([["x", "y"], ["1", "2"]]);
  });
});

describe("parseOOTradeLog", () => {
  it("maps OO columns to trades", () => {
    const { trades, errors } = parseOOTradeLog([HEADER, row()].join("\n"));
    expect(errors).toEqual([]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      strategy: "SPX 0DTE 5d IC 100-wide",
      dateOpened: "2026-10-20",
      timeOpened: "10:30:00",
      pl: 1106,
      contracts: 18,
      reason: "Expired",
      premium: 1260,
      openFees: 23.4,
      closeFees: 0,
      dateClosed: "2026-10-20",
    });
  });

  it("parses negative and parenthesised P/L and US dates", () => {
    const { trades } = parseOOTradeLog(
      [HEADER, row({ pl: "-651", timeOpened: "9:45" }), row({ pl: "($1,200.50)", dateOpened: "10/21/2026", timeOpened: "1:30 PM" })].join("\n"),
    );
    expect(trades.map((t) => t.pl)).toEqual([-651, -1200.5]);
    expect(trades[0].timeOpened).toBe("09:45:00");
    expect(trades[1].dateOpened).toBe("2026-10-21");
    expect(trades[1].timeOpened).toBe("13:30:00");
  });

  it("de-duplicates by strategy + date opened + time opened + legs", () => {
    const { trades, duplicatesInFile } = parseOOTradeLog(
      [HEADER, row(), row(), row({ legs: "9 Oct 20 7750 P BTO 28.16" }), row({ strategy: "Other" })].join("\n"),
    );
    expect(trades).toHaveLength(3);
    expect(duplicatesInFile).toBe(1);
  });

  it("falls back to the file name when Strategy is blank", () => {
    const { trades } = parseOOTradeLog([HEADER, row({ strategy: "" })].join("\n"), "My BWB");
    expect(trades[0].strategy).toBe("My BWB");
  });

  it("reports bad rows and missing columns", () => {
    expect(parseOOTradeLog("foo,bar\n1,2").errors[0]).toMatch(/Missing columns/);
    const { trades, errors } = parseOOTradeLog([HEADER, row({ pl: "abc" })].join("\n"));
    expect(trades).toHaveLength(0);
    expect(errors[0]).toMatch(/Line 2/);
  });
});
