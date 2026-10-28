// Option Omega trade-log CSV parsing.

export interface OOTrade {
  key: string;
  strategy: string;
  dateOpened: string; // YYYY-MM-DD
  timeOpened: string; // HH:MM:SS
  legs: string;
  premium: number | null;
  dateClosed: string | null;
  timeClosed: string | null;
  reason: string;
  pl: number;
  contracts: number;
  fundsAtClose: number | null;
  openFees: number;
  closeFees: number;
  /** OO "Margin Req." for the whole position (buying power held), when the log has it. */
  margin?: number | null;
}

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
}

export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  let s = v.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function parseDate(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

export function parseTime(v: string | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(v.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[4]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

export function tradeKey(t: Pick<OOTrade, "strategy" | "dateOpened" | "timeOpened" | "legs">): string {
  return [t.strategy.trim(), t.dateOpened, t.timeOpened, t.legs.replace(/\s+/g, " ").trim()].join("|");
}

export interface ParseResult {
  trades: OOTrade[];
  errors: string[];
  duplicatesInFile: number;
}

const REQUIRED = ["dateopened", "timeopened", "legs", "pl"];

/** Parse an OO trade log. `fallbackStrategy` is used when the Strategy column is missing/blank. */
export function parseOOTradeLog(text: string, fallbackStrategy = "Unnamed"): ParseResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (!rows.length) return { trades: [], errors: ["File is empty"], duplicatesInFile: 0 };
  const header = rows[0].map(normalizeHeader);
  const missing = REQUIRED.filter((r) => !header.includes(r));
  if (missing.length) return { trades: [], errors: [`Missing columns: ${missing.join(", ")}`], duplicatesInFile: 0 };
  const idx = (name: string) => header.indexOf(name);
  const get = (r: string[], name: string) => {
    const i = idx(name);
    return i >= 0 ? r[i] : undefined;
  };

  const seen = new Set<string>();
  const trades: OOTrade[] = [];
  let dupes = 0;
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const dateOpened = parseDate(get(r, "dateopened"));
    const timeOpened = parseTime(get(r, "timeopened"));
    const pl = parseNumber(get(r, "pl"));
    if (!dateOpened || !timeOpened || pl === null) {
      errors.push(`Line ${line}: missing/invalid Date Opened, Time Opened or P/L`);
      return;
    }
    const strategy = (get(r, "strategy") ?? "").trim() || fallbackStrategy;
    const legs = (get(r, "legs") ?? "").trim();
    const t: OOTrade = {
      key: "",
      strategy,
      dateOpened,
      timeOpened,
      legs,
      premium: parseNumber(get(r, "premium")),
      dateClosed: parseDate(get(r, "dateclosed")),
      timeClosed: parseTime(get(r, "timeclosed")),
      reason: (get(r, "reasonforclose") ?? "").trim(),
      pl,
      contracts: parseNumber(get(r, "noofcontracts")) ?? 1,
      fundsAtClose: parseNumber(get(r, "fundsatclose")),
      openFees: parseNumber(get(r, "openingcommissionsfees")) ?? 0,
      closeFees: parseNumber(get(r, "closingcommissionsfees")) ?? 0,
      margin: parseNumber(get(r, "marginreq")),
    };
    t.key = tradeKey(t);
    if (seen.has(t.key)) {
      dupes++;
      return;
    }
    seen.add(t.key);
    trades.push(t);
  });
  return { trades, errors, duplicatesInFile: dupes };
}

/** Validate a trade object coming from the client before storing it. */
export function isValidTrade(t: unknown): t is OOTrade {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.strategy === "string" &&
    typeof o.dateOpened === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.dateOpened) &&
    typeof o.timeOpened === "string" &&
    typeof o.legs === "string" &&
    typeof o.pl === "number" &&
    Number.isFinite(o.pl) &&
    typeof o.contracts === "number"
  );
}

export interface OOLeg {
  /** Signed contracts: − sold, + bought. */
  qty: number;
  putCall: "P" | "C";
  strike: number;
  expiration: string; // YYYY-MM-DD
  price: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse OO's legs text, e.g. "26 Oct 16 7600 P STO 0.85 | 26 Oct 16 7500 P BTO 0.20". */
export function parseLegs(legs: string, tradeDate: string): OOLeg[] {
  const [ty, tm] = tradeDate.split("-").map(Number);
  const out: OOLeg[] = [];
  for (const part of legs.split("|")) {
    const m = /^\s*(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+([\d.]+)\s+([PC])\s+(STO|BTO|STC|BTC)\s+([\d.]+)/i.exec(part);
    if (!m) continue;
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) continue;
    const year = month < tm ? ty + 1 : ty; // expiry in next year (e.g. Dec trade, Jan expiry)
    const sold = /^S/i.test(m[6]);
    out.push({
      qty: (sold ? -1 : 1) * Number(m[1]),
      putCall: m[5].toUpperCase() as "P" | "C",
      strike: Number(m[4]),
      expiration: `${year}-${String(month).padStart(2, "0")}-${m[3].padStart(2, "0")}`,
      price: Number(m[7]),
    });
  }
  return out;
}
