// Order guard (pure): which Schwab order calls Stock Trades may make, and equity-only order bodies.
const ORDER_PATHS: [string, RegExp][] = [
  ["POST", /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/orders$/],
  ["GET", /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/orders\/\d+$/],
  ["PUT", /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/orders\/\d+$/],
  ["DELETE", /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/orders\/\d+$/],
];

export function isAllowedOrderPath(method: string, path: string): boolean {
  return ORDER_PATHS.some(([m, re]) => m === method.toUpperCase() && re.test(path.split("?")[0]));
}

/** Equity orders only: refuse anything that isn't a stock/ETF leg, just in case. */
export function assertEquityOnly(body: unknown) {
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    for (const leg of (r.orderLegCollection as Record<string, unknown>[] | undefined) ?? []) {
      const ins = leg.instrument as Record<string, unknown> | undefined;
      if (ins?.assetType !== "EQUITY") throw new Error("Blocked: Stock Trades only sends equity orders");
    }
    for (const c of (r.childOrderStrategies as unknown[] | undefined) ?? []) walk(c);
  };
  walk(body);
}

