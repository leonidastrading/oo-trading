// Cash-settled index options that have expired but that Schwab hasn't posted yet
// (it posts settlements ~01:45 ET the next day). From the session close we value them
// at the settlement price and treat them as closed.
import { intrinsic, MULTIPLIER, parseOptionSymbol, rootToUnderlying } from "./options";
import { openLots, type ClosedOrder, type Fill } from "./realized";
import type { Position } from "./spreads";

export const CASH_SETTLED = new Set(["SPX", "NDX", "RUT", "XSP", "VIX", "DJX"]);

export interface ExpiredOpts {
  /** Session the expirations belong to (ET date). */
  sessionDate: string;
  /** Today's ET date. */
  today: string;
  /** True once today's session has closed (16:15 ET, 13:15 on early closes). */
  afterClose: boolean;
  /** Settlement price per underlying, e.g. { SPX: 7757.17 }. */
  settle: Record<string, number | null | undefined>;
  /** Fills already on the books (Schwab's posted settlements replace our estimate). */
  fills: Fill[];
}

/**
 * Legs that expired on sessionDate and are still open by our fills, but are no longer in Schwab's positions
 * and not posted yet. Overnight Schwab drops expired options from the account a few hours before it posts
 * every expiration, so without these the day's P/L would lose them in between.
 */
export function ghostExpired(positions: Position[], fills: Fill[], sessionDate: string): Position[] {
  const held = new Set(positions.map((p) => p.symbol));
  const posted = new Set(fills.filter((f) => f.settlement && f.bookDate === sessionDate).map((f) => f.symbol));
  const out: Position[] = [];
  for (const [symbol, lots] of openLots(fills)) {
    if (held.has(symbol) || posted.has(symbol) || !lots.length) continue;
    const o = parseOptionSymbol(symbol);
    if (!o || o.expiration !== sessionDate) continue;
    const underlying = rootToUnderlying(o.root);
    if (!CASH_SETTLED.has(underlying)) continue;
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    if (!qty) continue;
    const size = lots.reduce((s, l) => s + Math.abs(l.qty), 0);
    out.push({
      symbol,
      assetType: "OPTION",
      description: "",
      underlying,
      expiration: o.expiration,
      putCall: o.putCall,
      strike: o.strike,
      qty,
      avgPrice: lots.reduce((s, l) => s + Math.abs(l.qty) * l.price, 0) / size,
      mark: 0,
      marketValue: 0,
      plOpen: 0,
      plDay: 0,
    });
  }
  return out;
}

/** Positions that expired on sessionDate, are cash-settled, have a price, and aren't posted yet. */
/** Symbols of expired options Schwab has already settled (closed, whatever a cached position list says). */
export function settledSymbols(fills: Fill[], today: string): string[] {
  return fills.filter((f) => f.settlement && f.expiration !== null && f.expiration < today).map((f) => f.symbol);
}

export function pendingExpired(positions: Position[], o: ExpiredOpts): Position[] {
  const posted = new Set(o.fills.filter((f) => f.settlement && f.bookDate === o.sessionDate).map((f) => f.symbol));
  return positions.filter(
    (p) =>
      p.expiration === o.sessionDate &&
      p.putCall !== null &&
      p.strike !== null &&
      CASH_SETTLED.has(p.underlying) &&
      (p.expiration < o.today || o.afterClose) &&
      typeof o.settle[p.underlying] === "number" &&
      !posted.has(p.symbol),
  );
}

/** One "Expired (pending Schwab posting)" closed row per underlying, valued at settlement. */
export function expiredOrders(pending: Position[], o: ExpiredOpts): ClosedOrder[] {
  const byUnderlying = new Map<string, Position[]>();
  for (const p of pending) byUnderlying.set(p.underlying, [...(byUnderlying.get(p.underlying) ?? []), p]);
  return [...byUnderlying].map(([underlying, ps]) => {
    const settle = o.settle[underlying] as number;
    const legs = ps.map((p) => {
      const value = intrinsic(p.putCall!, p.strike!, settle);
      const realized = round2(p.qty * (value - p.avgPrice) * MULTIPLIER);
      const fill: Fill = {
        id: `expired-${p.symbol}`,
        time: 0,
        orderId: `expired-${underlying}-${o.sessionDate}`,
        type: "EXPIRED_PENDING",
        symbol: p.symbol,
        assetType: p.assetType,
        underlying,
        expiration: p.expiration,
        putCall: p.putCall,
        strike: p.strike,
        qty: -p.qty, // closing direction
        price: value,
        fees: 0,
        schwabFees: 0,
        cash: round2(-p.qty * value * MULTIPLIER),
        effect: "CLOSING",
        bookDate: o.sessionDate,
        settlement: true,
      };
      return { fill, closedQty: Math.abs(p.qty), realized };
    });
    return {
      orderId: `expired-${underlying}-${o.sessionDate}`,
      time: 0,
      underlying,
      legs,
      realized: round2(legs.reduce((s, l) => s + l.realized, 0)),
      unknownBasis: false,
      pending: { settle },
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
