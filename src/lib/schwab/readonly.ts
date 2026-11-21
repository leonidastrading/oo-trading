// READ-ONLY guard: the only Schwab API paths the dashboard's data client may call.
// Order placement lives only in ./trading.ts (Stock Trades tab), behind its own path allowlist, the
// server-side guardrails and the STOCK_LIVE_TRADING switch; nothing else in the app can send an order.

export const SCHWAB_API = "https://api.schwabapi.com";

const ALLOWED_GET_PATHS: RegExp[] = [
  /^\/trader\/v1\/accounts\/accountNumbers$/,
  /^\/trader\/v1\/accounts\/[A-Za-z0-9]+$/, // account + positions + balances
  /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/transactions$/,
  /^\/marketdata\/v1\/quotes$/,
  /^\/marketdata\/v1\/pricehistory$/, // intraday bars for the SPX chart
  /^\/marketdata\/v1\/chains$/, // option chain quotes for the 0DTE premium gauge
  /^\/trader\/v1\/userPreference$/, // account nicknames (shown on the Stock Trades tab)
];

export function isAllowedSchwabPath(method: string, path: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const pathname = path.split("?")[0];
  return ALLOWED_GET_PATHS.some((re) => re.test(pathname));
}

export function assertReadOnly(method: string, path: string): void {
  if (!isAllowedSchwabPath(method, path)) {
    throw new Error(`Blocked Schwab request: ${method} ${path} (dashboard is read-only)`);
  }
}
