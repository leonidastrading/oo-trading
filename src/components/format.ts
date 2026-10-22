export function money(n: number | null | undefined, opts: { cents?: boolean; sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
  if (n < 0) return `−$${abs}`;
  return `${opts.sign && n > 0 ? "+" : ""}$${abs}`;
}

export function num(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

/** Tailwind text class for a P/L value. */
export function plClass(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return "text-ink-2";
  return n > 0 ? "text-gain" : "text-loss";
}

export function strike(n: number | null): string {
  if (n === null) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function priceRange(r: { low: number; high: number } | null, single: number): string {
  return r ? `${strike(r.low)}–${strike(r.high)}` : strike(single);
}

// Categorical slots (dark-mode steps), assigned in fixed order by strategy name.
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** "3 open positions · 12 legs": entries (one per Schwab order) and the legs they hold. */
export function openPositionsLabel(entries: number, groups: { positions: unknown[] }[]): string {
  const legs = groups.reduce((s, g) => s + g.positions.length, 0);
  return `${entries} open position${entries === 1 ? "" : "s"} · ${legs} leg${legs === 1 ? "" : "s"}`;
}
