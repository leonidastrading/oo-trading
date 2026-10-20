// READ-ONLY guard: the only Schwab API paths this app is allowed to call.
// There is intentionally no order-placement code anywhere in this project.

export const SCHWAB_API = "https://api.schwabapi.com";

const ALLOWED_GET_PATHS: RegExp[] = [
  /^\/trader\/v1\/accounts\/accountNumbers$/,
  /^\/trader\/v1\/accounts\/[A-Za-z0-9]+$/, // account + positions + balances
  /^\/trader\/v1\/accounts\/[A-Za-z0-9]+\/transactions$/,
  /^\/marketdata\/v1\/quotes$/,
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
