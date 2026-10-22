// Schwab transactions -> fills -> FIFO realized P/L.
import { MULTIPLIER, parseOptionSymbol, rootToUnderlying, type PutCall } from "./options";
import { splitByEntry, type EntryLot, type Position } from "./spreads";
import { todayET } from "./time";

export interface SchwabTransferItem {
  instrument?: { assetType?: string; symbol?: string; underlyingSymbol?: string; description?: string };
  amount?: number;
  cost?: number;
  price?: number;
  feeType?: string;
  positionEffect?: "OPENING" | "CLOSING" | string;
}

export interface SchwabTransaction {
  activityId?: number;
  time?: string;
  tradeDate?: string;
  type?: string;
  orderId?: number;
  netAmount?: number;
  description?: string;
  transferItems?: SchwabTransferItem[];
}

export interface Fill {
  id: string;
  time: number;
  orderId: string;
  type: string;
  symbol: string;
  assetType: string;
  underlying: string;
  expiration: string | null;
  putCall: PutCall | null;
  strike: number | null;
  /** Signed: + bought, − sold. */
  qty: number;
  price: number;
  fees: number;
  /** Signed cash flow including fees (+ received). */
  cash: number;
  effect: "OPENING" | "CLOSING" | null;
  /**
   * Session (ET date) this fill belongs to. Normally the trade date, but Schwab posts
   * cash settlements of expired index options overnight (≈01:45 ET the next day);
   * those belong to the option's expiration date, not the posting date.
   */
  bookDate: string;
  /** True for post-expiry settlement rows (no commission, not a traded contract). */
  settlement: boolean;
}

const isFee = (it: SchwabTransferItem) => it.instrument?.assetType === "CURRENCY" || !!it.feeType;

/**
 * @param feePerContract If set, option fees are |contracts| × this rate per side (your broker's
 * schedule) instead of the fees Schwab reports on each transaction.
 */
export function normalizeTransactions(txs: SchwabTransaction[], feePerContract?: number): Fill[] {
  const fills: Fill[] = [];
  for (const tx of txs) {
    const items = tx.transferItems ?? [];
    const legs = items.filter((it) => !isFee(it) && it.instrument?.symbol && it.amount);
    if (!legs.length) continue;
    const settlement = legs.length === 1 && legs[0].price === undefined && legs[0].cost === undefined;
    const mult = (it: SchwabTransferItem) => (it.instrument?.assetType === "OPTION" ? MULTIPLIER : 1);
    const legCash = legs.map((it) => it.cost ?? -(it.amount ?? 0) * (it.price ?? 0) * mult(it));
    const grossCash = legCash.reduce((a, b) => a + b, 0);
    const feeItems = items.filter(isFee).reduce((a, it) => a + Math.abs(it.cost ?? 0), 0);
    let fees = feeItems;
    if (typeof tx.netAmount === "number") {
      // Single-leg settlement rows (e.g. expirations) may carry no price; trust netAmount.
      if (settlement) {
        legCash[0] = tx.netAmount;
        fees = 0;
      } else {
        fees = Math.max(0, round2(grossCash - tx.netAmount));
      }
    }
    const totalQty = legs.reduce((a, it) => a + Math.abs(it.amount ?? 0), 0);
    const time = Date.parse(tx.time ?? tx.tradeDate ?? "") || 0;
    legs.forEach((it, i) => {
      const symbol = it.instrument!.symbol!;
      const parsed = parseOptionSymbol(symbol);
      const qty = it.amount ?? 0;
      // A fill posted after the option's expiration date is a settlement of that expiry
      // (Schwab posts SPX cash settlements ~01:45 ET next day, with a price and CLOSING effect).
      const tradeDay = todayET(time);
      const postExpiry = !!parsed && parsed.expiration < tradeDay;
      const isSettlement = settlement || postExpiry;
      const fee =
        feePerContract !== undefined && it.instrument?.assetType === "OPTION"
          ? isSettlement
            ? 0 // expirations/exercises/cash settlements carry no commission
            : Math.abs(qty) * feePerContract
          : totalQty
            ? (fees * Math.abs(qty)) / totalQty
            : 0;
      fills.push({
        id: `${tx.activityId ?? time}-${i}`,
        time,
        orderId: String(tx.orderId ?? tx.activityId ?? time),
        type: tx.type ?? "TRADE",
        symbol,
        assetType: it.instrument?.assetType ?? "UNKNOWN",
        underlying: parsed ? rootToUnderlying(parsed.root) : (it.instrument?.underlyingSymbol ?? symbol).replace(/^\$/, ""),
        expiration: parsed?.expiration ?? null,
        putCall: parsed?.putCall ?? null,
        strike: parsed?.strike ?? null,
        qty,
        price: it.price ?? 0,
        fees: round2(fee),
        cash: round2(legCash[i] - fee),
        effect: it.positionEffect === "OPENING" || it.positionEffect === "CLOSING" ? it.positionEffect : null,
        bookDate: postExpiry ? parsed!.expiration : tradeDay,
        settlement: isSettlement,
      });
    });
  }
  return fills.sort((a, b) => a.time - b.time);
}

/** Contracts and fees for fills on `date` (ET). */
export function feesOn(fills: Fill[], date: string): { contracts: number; fees: number } {
  // Settlements are not traded contracts and carry no commission.
  const today = fills.filter((f) => f.bookDate === date && f.assetType === "OPTION" && !f.settlement);
  return {
    contracts: today.reduce((s, f) => s + Math.abs(f.qty), 0),
    fees: round2(today.reduce((s, f) => s + f.fees, 0)),
  };
}

export interface ClosedLeg {
  fill: Fill;
  closedQty: number;
  /** null when the opening lot predates the lookback window. */
  realized: number | null;
}

interface Lot {
  qty: number;
  cashPerUnit: number;
  orderId: string;
  price: number;
  time: number;
}

/** FIFO-match fills; calls onClose for each closing fill and returns the still-open lots per symbol. */
function runFifo(
  fills: Fill[],
  onClose?: (f: Fill, matched: number, realized: number, unmatched: number) => void,
): Map<string, Lot[]> {
  const lots = new Map<string, Lot[]>();
  for (const f of [...fills].sort((a, b) => a.time - b.time)) {
    const queue = lots.get(f.symbol) ?? [];
    lots.set(f.symbol, queue);
    const opposite = queue.length > 0 && Math.sign(queue[0].qty) !== Math.sign(f.qty);
    const closing = f.effect ? f.effect === "CLOSING" : opposite;
    if (!closing) {
      queue.push({ qty: f.qty, cashPerUnit: f.cash / Math.abs(f.qty), orderId: f.orderId, price: f.price, time: f.time });
      continue;
    }
    let remaining = Math.abs(f.qty);
    const closeCashPerUnit = f.cash / Math.abs(f.qty);
    let realized = 0;
    let matched = 0;
    while (remaining > 0 && queue.length && Math.sign(queue[0].qty) !== Math.sign(f.qty)) {
      const lot = queue[0];
      const m = Math.min(remaining, Math.abs(lot.qty));
      realized += (lot.cashPerUnit + closeCashPerUnit) * m;
      matched += m;
      remaining -= m;
      lot.qty -= Math.sign(lot.qty) * m;
      if (lot.qty === 0) queue.shift();
    }
    onClose?.(f, matched, realized, remaining);
  }
  return lots;
}

/**
 * FIFO-match closing fills against earlier opening fills in the window and return
 * the closes that happened on `date` (ET) with their realized P/L (net of fees).
 */
export function realizedOn(fills: Fill[], date: string): ClosedLeg[] {
  const out: ClosedLeg[] = [];
  runFifo(fills, (f, matched, realized, remaining) => {
    if (f.bookDate !== date) return;
    if (matched > 0) out.push({ fill: f, closedQty: matched, realized: round2(realized) });
    if (remaining > 0) out.push({ fill: f, closedQty: remaining, realized: null });
  });
  return out;
}

/** Still-open lots per symbol after FIFO matching, with the order that opened them. */
export function openLots(fills: Fill[]): Map<string, EntryLot[]> {
  return runFifo(fills);
}

/**
 * Number of open strategy entries: legs opened in the same Schwab order (same orderId)
 * count once, even when several strategies enter in the same second. Open legs whose
 * opening fill predates the lookback window are grouped by underlying + expiration.
 */
export function countOpenEntries(fills: Fill[], positions: Position[]): number {
  return new Set(splitByEntry(positions, openLots(fills)).map((p) => p.entryKey)).size;
}

export interface ClosedOrder {
  orderId: string;
  time: number;
  underlying: string;
  legs: ClosedLeg[];
  realized: number;
  unknownBasis: boolean;
  /** Set for expired options valued at settlement that Schwab hasn't posted yet. */
  pending?: { settle: number };
}

export function groupClosesByOrder(closes: ClosedLeg[]): ClosedOrder[] {
  const map = new Map<string, ClosedOrder>();
  for (const c of closes) {
    const o =
      map.get(c.fill.orderId) ??
      ({ orderId: c.fill.orderId, time: c.fill.time, underlying: c.fill.underlying, legs: [], realized: 0, unknownBasis: false } as ClosedOrder);
    o.legs.push(c);
    if (c.realized === null) o.unknownBasis = true;
    else o.realized = round2(o.realized + c.realized);
    map.set(c.fill.orderId, o);
  }
  return [...map.values()].sort((a, b) => b.time - a.time);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
