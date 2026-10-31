import { describe, expect, it } from "vitest";
import { classifyBookEntry, tradingDte } from "@/lib/strategyRules";
import live from "./fixtures-live-entries.json";

const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
type L = { putCall: "P" | "C"; strike: number; qty: number; expiration: string };
const leg = (putCall: "P" | "C", strike: number, qty: number, expiration = "2026-11-02"): L => ({ putCall, strike, qty, expiration });

describe("book strategy rules", () => {
  it("labels every live entry from Oct 27–30 the way the scorecard matched it", () => {
    for (const e of live) expect([e.date, e.time, classifyBookEntry(e.legs as L[], e.date, min(e.time))]).toEqual([e.date, e.time, e.want]);
  });

  it("counts DTE in trading days (Friday → Monday is 1)", () => {
    expect(tradingDte("2026-10-30", "2026-11-02")).toBe(1);
    expect(tradingDte("2026-10-29", "2026-11-02")).toBe(2);
  });

  it("tells the single put spreads apart by width and DTE", () => {
    const d = "2026-11-02";
    expect(classifyBookEntry([leg("P", 6800, -10, d), leg("P", 6700, 10, d)], d, 600)).toBe("Long");
    expect(classifyBookEntry([leg("P", 6800, -3, "2026-11-04"), leg("P", 6725, 3, "2026-11-04")], d, 930)).toBe("2DTE");
    expect(classifyBookEntry([leg("P", 6800, -3, "2026-11-03"), leg("P", 6750, 3, "2026-11-03")], d, 810)).toBe("VIX>30 1DTE");
    expect(classifyBookEntry([leg("C", 6900, -4, d), leg("C", 7000, 4, d)], d, 700)).toBe("Short");
  });

  it("tells the iron condors apart by wing widths", () => {
    const d = "2026-11-02";
    const ic = (pw: number, cw: number) => [leg("P", 6700 - pw, 2, d), leg("P", 6700, -2, d), leg("C", 6800, -2, d), leg("C", 6800 + cw, 2, d)];
    expect(classifyBookEntry(ic(25, 100), d, 810)).toBe("8SMA IC");
    expect(classifyBookEntry(ic(50, 50), d, 815)).toBe("$8 IC");
    expect(classifyBookEntry(ic(100, 100), d, 870)).toBe("5d IC");
    expect(classifyBookEntry(ic(60, 40), d, 815)).toBeNull();
  });

  it("knows the straddle and leaves unknown structures alone", () => {
    const d = "2026-11-02";
    expect(classifyBookEntry([leg("C", 6800, 5, d), leg("P", 6800, 5, d)], d, 875)).toBe("FOMC");
    expect(classifyBookEntry([leg("P", 6800, -5, d)], d, 600)).toBeNull();
  });
});
