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
  /** Strategy entry this leg belongs to (set by splitByEntry): "order:<id>" or "older:<underlying>|<exp>". */
  entryKey?: string;
  /** When the entry's opening order filled (epoch ms), if known. */
  enteredAt?: number | null;
}

/** An open lot from FIFO matching of fills. */
export interface EntryLot {
  qty: number;
  price: number;
  orderId: string;
  time: number;
}

/**
 * Split Schwab's netted positions back into strategy entries using the open lots from
 * fills: each opening order becomes its own set of legs at its own fill prices. Quantity
 * not covered by lots (opened before the lookback window) stays at Schwab's average price.
 */
export function splitByEntry(positions: Position[], lots: Map<string, EntryLot[]>): Position[] {
  const out: Position[] = [];
  for (const p of positions) {
    if (p.qty === 0) continue;
    const mult = p.assetType === "OPTION" ? MULTIPLIER : 1;
    const olderKey = `older:${p.underlying}|${p.expiration ?? p.symbol}`;
    // Newest lots first, capped at the position size.
    const byOrder = new Map<string, { qty: number; cost: number; time: number }>();
    let left = Math.abs(p.qty);
    for (const lot of [...(lots.get(p.symbol) ?? [])].reverse()) {
      if (left <= 0) break;
      if (Math.sign(lot.qty) !== Math.sign(p.qty)) continue;
      const q = Math.min(left, Math.abs(lot.qty));
      left -= q;
      const o = byOrder.get(lot.orderId) ?? { qty: 0, cost: 0, time: lot.time };
      o.qty += q;
      o.cost += q * lot.price;
      o.time = Math.min(o.time, lot.time);
      byOrder.set(lot.orderId, o);
    }
    const sign = Math.sign(p.qty);
    const share = (qty: number) => Math.abs(qty) / Math.abs(p.qty);
    let explainedPl = 0;
    for (const [orderId, o] of byOrder) {
      const qty = sign * o.qty;
      const avg = o.cost / o.qty;
      const plOpen = qty * (p.mark - avg) * mult;
      explainedPl += plOpen;
      out.push({
        ...p,
        qty,
        avgPrice: avg,
        marketValue: qty * p.mark * mult,
        plOpen,
        plDay: p.plDay * share(qty),
        entryKey: `order:${orderId}`,
        enteredAt: o.time,
      });
    }
    if (left > 0) {
      const qty = sign * left;
      out.push({
        ...p,
        qty,
        marketValue: qty * p.mark * mult,
        // Whatever Schwab's open P/L doesn't attribute to the entries above.
        plOpen: byOrder.size ? p.plOpen - explainedPl : p.plOpen,
        plDay: p.plDay * share(qty),
        entryKey: olderKey,
        enteredAt: null,
      });
    }
  }
  return out;
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
  /** Entry time when the group is a single strategy entry (see splitByEntry). */
  enteredAt: number | null;
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
    const base = p.expiration ? `${p.underlying}|${p.expiration}` : `${p.underlying}|${p.symbol}`;
    const key = p.entryKey ? `${base}|${p.entryKey}` : base;
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
      enteredAt: first.enteredAt ?? null,
    });
  }
  return groups.sort(
    (a, b) =>
      (a.expiration ?? "9999").localeCompare(b.expiration ?? "9999") ||
      a.underlying.localeCompare(b.underlying) ||
      (a.enteredAt ?? 0) - (b.enteredAt ?? 0),
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
