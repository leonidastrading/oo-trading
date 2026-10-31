// Tell the book's strategies apart from an entry's structure, using the rules the strategies are set up with
// (Oct 31, 2026). Deltas aren't known at entry, so it goes by legs, wing widths, DTE and entry time.
//
//   Long      9:32–13:45 floating   short put, long put 100 below                     0DTE
//   Short     9:32–14:30 floating   short call, long call 100 above                   0DTE
//   8SMA IC   13:30                 iron condor, put wing 25, call wing 100           0DTE
//   $8 IC     13:35                 iron condor, 50 each side (Dip Add-On: same)      0DTE
//   5d IC     13:30 / 14:30         iron condor, 100 each side                        0DTE
//   BWB       13:50 / 14:20 / 14:50 2× short put, +1 put 30 above, +1 put 45 below    0DTE
//   2DTE      15:30                 short put, long put 75 below                      2 trading days
//   VIX-up PS 15:50                 two put credit spreads, 50 wide each              1 trading day
//   VIX>30    13:30                 short put, long put 50 below                      1 trading day
//   FOMC      14:35                 long ATM call + put (straddle)                    0DTE
import { addDays, isTradingDay } from "./time";

export interface RuleLeg {
  putCall: "P" | "C" | null;
  strike: number | null;
  qty: number;
  expiration: string | null;
}

/** Trading days from the entry date to expiration (Friday → Monday is 1). */
export function tradingDte(entryDate: string, expiration: string): number {
  let n = 0;
  for (let d = entryDate; d < expiration && n < 30; ) {
    d = addDays(d, 1);
    if (isTradingDay(d)) n++;
  }
  return n;
}

const near = (a: number, b: number, tol = 2.5) => Math.abs(a - b) <= tol;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Entry-time windows (minutes after midnight ET), with a few minutes' slack, used to settle ties. */
const WINDOWS: Record<string, [number, number][]> = {
  Long: [[9 * 60 + 30, 13 * 60 + 50]],
  Short: [[9 * 60 + 30, 14 * 60 + 35]],
  "8SMA IC": [[13 * 60 + 25, 13 * 60 + 40]],
  "$8 IC": [[13 * 60 + 30, 13 * 60 + 45]],
  "5d IC": [[13 * 60 + 25, 13 * 60 + 40], [14 * 60 + 25, 14 * 60 + 40]],
  BWB: [[13 * 60 + 45, 14 * 60 + 0], [14 * 60 + 15, 14 * 60 + 30], [14 * 60 + 45, 15 * 60 + 0]],
  "2DTE": [[15 * 60 + 25, 15 * 60 + 40]],
  "VIX-up PS": [[15 * 60 + 45, 16 * 60 + 0]],
  "VIX>30 1DTE": [[13 * 60 + 25, 13 * 60 + 40]],
  FOMC: [[14 * 60 + 30, 14 * 60 + 45]],
};

export function inWindow(strategy: string, minutes: number): boolean {
  return (WINDOWS[strategy] ?? []).some(([a, b]) => minutes >= a && minutes <= b);
}

/**
 * The book strategy an entry's legs describe, or null when they match none of the rules.
 * `minutes` is the entry time (minutes after midnight ET); it only breaks ties.
 */
export function classifyBookEntry(legs: RuleLeg[], entryDate: string, minutes: number | null = null): string | null {
  const opts = legs.filter((l) => l.putCall && l.strike !== null && l.expiration && l.qty !== 0);
  if (!opts.length) return null;
  const units = opts.map((l) => Math.abs(l.qty)).reduce(gcd);
  const ls = opts.map((l) => ({ pc: l.putCall!, k: l.strike!, q: l.qty / units, dte: tradingDte(entryDate, l.expiration!) }));
  const dtes = new Set(ls.map((l) => l.dte));
  if (dtes.size !== 1) return null;
  const dte = ls[0].dte;
  const puts = ls.filter((l) => l.pc === "P").sort((a, b) => a.k - b.k);
  const calls = ls.filter((l) => l.pc === "C").sort((a, b) => a.k - b.k);
  const candidates: string[] = [];

  // Credit vertical: one short, one long the same size; width = |short − long|.
  const creditVertical = (xs: typeof ls, pc: "P" | "C") => {
    if (xs.length !== 2 || xs[0].q !== -xs[1].q || Math.abs(xs[0].q) !== 1) return null;
    const short = xs.find((x) => x.q < 0)!;
    const long = xs.find((x) => x.q > 0)!;
    const otm = pc === "P" ? long.k < short.k : long.k > short.k; // long leg further OTM → credit
    return otm ? Math.abs(short.k - long.k) : null;
  };

  if (calls.length === 0 && puts.length === 2) {
    const w = creditVertical(puts, "P");
    if (w !== null) {
      if (dte === 0 && near(w, 100)) candidates.push("Long");
      if (dte === 2 && near(w, 75)) candidates.push("2DTE");
      if (dte === 1 && near(w, 50)) candidates.push("VIX>30 1DTE");
    }
  }
  if (puts.length === 0 && calls.length === 2 && dte === 0) {
    const w = creditVertical(calls, "C");
    if (w !== null && near(w, 100)) candidates.push("Short");
  }
  if (puts.length === 2 && calls.length === 2 && dte === 0) {
    const pw = creditVertical(puts, "P");
    const cw = creditVertical(calls, "C");
    if (pw !== null && cw !== null) {
      if (near(pw, 25) && near(cw, 100)) candidates.push("8SMA IC");
      if (near(pw, 50) && near(cw, 50)) candidates.push("$8 IC");
      if (near(pw, 100) && near(cw, 100)) candidates.push("5d IC");
    }
    // Long straddle written as call + put at one strike shows up as 2 legs, not 4; see below.
  }
  // BWB: puts +1 / −2 / +1, upper wing 30, lower wing 45.
  if (calls.length === 0 && dte === 0) {
    const byK = new Map<number, number>();
    for (const p of puts) byK.set(p.k, (byK.get(p.k) ?? 0) + p.q);
    const ks = [...byK].filter(([, q]) => q !== 0).sort((a, b) => a[0] - b[0]);
    if (ks.length === 3 && ks[0][1] === 1 && ks[1][1] === -2 && ks[2][1] === 1) {
      if (near(ks[2][0] - ks[1][0], 30) && near(ks[1][0] - ks[0][0], 45)) candidates.push("BWB");
    }
  }
  // VIX-up: two 50-wide put credit spreads (−1/−1 shorts, +1/+1 longs 50 below each).
  if (calls.length === 0 && puts.length === 4 && dte === 1) {
    const shorts = puts.filter((p) => p.q === -1).map((p) => p.k).sort((a, b) => a - b);
    const longs = puts.filter((p) => p.q === 1).map((p) => p.k).sort((a, b) => a - b);
    if (shorts.length === 2 && longs.length === 2 && near(shorts[0] - longs[0], 50) && near(shorts[1] - longs[1], 50)) {
      candidates.push("VIX-up PS");
    }
  }
  // FOMC straddle: long call + long put at the same strike.
  if (puts.length === 1 && calls.length === 1 && dte === 0 && puts[0].q === 1 && calls[0].q === 1 && near(puts[0].k, calls[0].k, 5)) {
    candidates.push("FOMC");
  }

  if (candidates.length <= 1 || minutes === null) return candidates[0] ?? null;
  return candidates.find((s) => inWindow(s, minutes)) ?? candidates[0];
}
