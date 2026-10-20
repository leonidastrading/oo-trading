// Normalize Schwab positions and group them into spreads by underlying + expiration.
import { MULTIPLIER, parseOptionSymbol, rootToUnderlying, type OptionLeg, type PutCall } from "./options";
import { addDays } from "./time";

export interface SchwabInstrument {
  assetType: string;
  symbol: string;
  description?: string;
  putCall?: "PUT" | "CALL";
  underlyingSymbol?: string;
}

export interface SchwabPosition {
  shortQuantity?: number;
  longQuantity?: number;
  averagePrice?: number;
  averageLongPrice?: number;
  averageShortPrice?: number;
  marketValue?: number;
  currentDayProfitLoss?: number;
  longOpenProfitLoss?: number;
  shortOpenProfitLoss?: number;
  instrument: SchwabInstrument;
}

export interface Position {
  symbol: string;
  assetType: string;
  description: string;
  underlying: string;
  expiration: string | null;
  putCall: PutCall | null;
  strike: number | null;
  /** Signed quantity (contracts or shares). */
  qty: number;
  avgPrice: number;
  mark: number;
  marketValue: number;
  plOpen: number;
  plDay: number;
}

export function normalizePosition(p: SchwabPosition): Position {
  const qty = (p.longQuantity ?? 0) - (p.shortQuantity ?? 0);
  const isOption = p.instrument.assetType === "OPTION";
  const parsed = isOption ? parseOptionSymbol(p.instrument.symbol) : null;
  const mult = isOption ? MULTIPLIER : 1;
  const avgPrice =
    p.averagePrice ?? (qty >= 0 ? p.averageLongPrice : p.averageShortPrice) ?? 0;
  const marketValue = p.marketValue ?? 0;
  const mark = qty !== 0 ? Math.abs(marketValue) / (Math.abs(qty) * mult) : 0;
  const plOpen =
    qty >= 0
      ? p.longOpenProfitLoss ?? marketValue - qty * avgPrice * mult
      : p.shortOpenProfitLoss ?? marketValue - qty * avgPrice * mult;
  const underlying = parsed
    ? rootToUnderlying(parsed.root)
    : (p.instrument.underlyingSymbol ?? p.instrument.symbol).replace(/^\$/, "");
  return {
    symbol: p.instrument.symbol,
    assetType: p.instrument.assetType,
    description: p.instrument.description ?? p.instrument.symbol,
    underlying,
    expiration: parsed?.expiration ?? null,
    putCall: parsed?.putCall ?? (p.instrument.putCall ? (p.instrument.putCall === "PUT" ? "P" : "C") : null),
    strike: parsed?.strike ?? null,
    qty,
    avgPrice,
    mark,
    marketValue,
    plOpen,
    plDay: p.currentDayProfitLoss ?? 0,
  };
}

export function toLeg(p: Position): OptionLeg | null {
  if (p.expiration === null || p.putCall === null || p.strike === null) return null;
  const parsed = parseOptionSymbol(p.symbol);
  return {
    symbol: p.symbol,
    underlying: p.underlying,
    root: parsed?.root ?? p.underlying,
    expiration: p.expiration,
    putCall: p.putCall,
    strike: p.strike,
    qty: p.qty,
    avgPrice: p.avgPrice,
  };
}

export interface SpreadGroup {
  key: string;
  underlying: string;
  expiration: string | null;
  dte: number | null;
  isToday: boolean;
  label: string;
  positions: Position[];
  plOpen: number;
  plDay: number;
  marketValue: number;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/** Group positions by underlying + expiration; stocks get their own group per symbol. */
export function groupSpreads(positions: Position[], today: string): SpreadGroup[] {
  const map = new Map<string, Position[]>();
  for (const p of positions) {
    if (p.qty === 0) continue;
    const key = p.expiration ? `${p.underlying}|${p.expiration}` : `${p.underlying}|${p.symbol}`;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  const groups: SpreadGroup[] = [];
  for (const [key, list] of map) {
    const first = list[0];
    list.sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0) || (a.putCall ?? "").localeCompare(b.putCall ?? ""));
    const dte = first.expiration ? daysBetween(today, first.expiration) : null;
    groups.push({
      key,
      underlying: first.underlying,
      expiration: first.expiration,
      dte,
      isToday: dte === 0,
      label: first.expiration ? classifySpread(list) : first.assetType === "EQUITY" ? "Stock" : first.assetType,
      positions: list,
      plOpen: sum(list.map((p) => p.plOpen)),
      plDay: sum(list.map((p) => p.plDay)),
      marketValue: sum(list.map((p) => p.marketValue)),
    });
  }
  return groups.sort(
    (a, b) =>
      (a.expiration ?? "9999").localeCompare(b.expiration ?? "9999") || a.underlying.localeCompare(b.underlying),
  );
}

/** Best-effort structure name for a set of legs sharing one expiration. */
export function classifySpread(legs: Pick<Position, "putCall" | "strike" | "qty">[]): string {
  const opts = legs.filter((l) => l.putCall && l.strike !== null && l.qty !== 0);
  const puts = opts.filter((l) => l.putCall === "P").sort((a, b) => a.strike! - b.strike!);
  const calls = opts.filter((l) => l.putCall === "C").sort((a, b) => a.strike! - b.strike!);
  const name = (pc: string) => (pc === "P" ? "Put" : "Call");

  if (opts.length === 1) return `${opts[0].qty > 0 ? "Long" : "Short"} ${name(opts[0].putCall!)}`;

  const vertical = (ls: typeof opts) =>
    ls.length === 2 && ls[0].qty === -ls[1].qty;

  if (opts.length === 2 && (puts.length === 2 || calls.length === 2)) {
    const ls = puts.length === 2 ? puts : calls;
    if (vertical(ls)) {
      // Credit if the short leg is closer to the money (higher put / lower call).
      const short = ls.find((l) => l.qty < 0)!;
      const credit = puts.length === 2 ? short === ls[1] : short === ls[0];
      return `${name(ls[0].putCall!)} ${credit ? "credit" : "debit"} spread`;
    }
  }

  if (opts.length === 4 && puts.length === 2 && calls.length === 2 && vertical(puts) && vertical(calls)) {
    const shortPut = puts[1].qty < 0;
    const shortCall = calls[0].qty < 0;
    if (shortPut && shortCall) return puts[1].strike === calls[0].strike ? "Iron butterfly" : "Iron condor";
    if (!shortPut && !shortCall) return "Reverse iron condor";
  }

  const fly = (ls: typeof opts) => {
    if (ls.length !== 3) return null;
    const [a, b, c] = ls;
    if (!(a.qty > 0 && c.qty > 0 && b.qty < 0 && a.qty + c.qty === -b.qty)) return null;
    const lower = b.strike! - a.strike!;
    const upper = c.strike! - b.strike!;
    return lower === upper && a.qty === c.qty ? "butterfly" : "broken-wing butterfly";
  };
  if (puts.length === 3 && calls.length === 0) {
    const f = fly(puts);
    if (f) return `Put ${f}`;
  }
  if (calls.length === 3 && puts.length === 0) {
    const f = fly(calls);
    if (f) return `Call ${f}`;
  }
  return `Custom (${opts.length} legs)`;
}

export function dteLabel(dte: number | null): string {
  if (dte === null) return "";
  return `${dte}DTE`;
}

export function expirationLabel(expiration: string, today: string): string {
  if (expiration === today) return "Today";
  if (expiration === addDays(today, 1)) return "Tomorrow";
  return new Date(expiration + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
