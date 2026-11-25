// Market reference data for the Stocks portfolio stats: each stock's sector, and how many S&P 500 stocks
// are up or down today. Public sources (no key), read-only, cached so they are fetched rarely.
import "server-only";
import { cached } from "../cache";
import { fetchQuotes } from "../schwab/data";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const NASDAQ_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true";
const SP500_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const WEEK_S = 8 * 86_400;

/** One spelling for share classes: BRK.B, BRK/B and BRK-B are the same stock. */
export const normSymbol = (s: string) => s.trim().toUpperCase().replace(/[./]/g, "-");

interface NasdaqRow {
  symbol?: string;
  sector?: string;
}

async function nasdaqRows(): Promise<NasdaqRow[]> {
  const res = await fetch(NASDAQ_URL, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Nasdaq screener answered ${res.status}`);
  const j = (await res.json()) as { data?: { rows?: NasdaqRow[] } };
  const rows = j.data?.rows ?? [];
  if (rows.length < 1000) throw new Error("Nasdaq screener returned too few stocks");
  return rows;
}

export interface SectorMap {
  sectors: string[];
  /** Normalised symbol -> index into `sectors`. */
  map: Record<string, number>;
}

/** Sector of every US-listed stock (Nasdaq's classification). Refreshed weekly. */
export function sectorMap() {
  return cached<SectorMap>(
    "stocks:sectors:v1",
    7 * 86_400_000,
    async () => {
      const sectors: string[] = [];
      const map: Record<string, number> = {};
      for (const r of await nasdaqRows()) {
        const sec = (r.sector ?? "").trim();
        if (!r.symbol || !sec) continue;
        let i = sectors.indexOf(sec);
        if (i < 0) i = sectors.push(sec) - 1;
        map[normSymbol(r.symbol)] = i;
      }
      return { sectors, map };
    },
    { keepSeconds: WEEK_S },
  );
}

/** Current S&P 500 members (normalised symbols). Refreshed weekly. */
function sp500() {
  return cached<string[]>(
    "stocks:sp500:v1",
    7 * 86_400_000,
    async () => {
      const res = await fetch(SP500_URL, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`S&P 500 list answered ${res.status}`);
      const syms = (await res.text())
        .split("\n")
        .slice(1)
        .map((l) => normSymbol(l.split(",")[0] ?? ""))
        .filter((s) => /^[A-Z][A-Z0-9-]{0,9}$/.test(s));
      if (syms.length < 400) throw new Error("S&P 500 list looks incomplete");
      return syms;
    },
    { keepSeconds: WEEK_S },
  );
}

export interface Breadth {
  advancers: number;
  decliners: number;
  unchanged: number;
  /** Members with a price change found (of ~503). */
  counted: number;
  at: number;
}

/**
 * S&P 500 stocks up / down / flat today, from live Schwab quotes of the members (three requests per
 * refresh). Nasdaq's screener can't be used for this: its prices are the previous session's close.
 */
export function sp500Breadth(maxAgeMs: number) {
  return cached<Breadth>("stocks:breadth:v2", maxAgeMs, async () => {
    const members = (await sp500()).data;
    if (!members) throw new Error("No S&P 500 member list");
    const b: Breadth = { advancers: 0, decliners: 0, unchanged: 0, counted: 0, at: Date.now() };
    const BATCH = 170;
    for (let i = 0; i < members.length; i += BATCH) {
      // Schwab writes share classes with a slash (BRK/B).
      const quotes = await fetchQuotes(members.slice(i, i + BATCH).map((m) => m.replace("-", "/")));
      for (const q of Object.values(quotes)) {
        if (q.changePct === null) continue;
        b.counted++;
        if (q.changePct > 0) b.advancers++;
        else if (q.changePct < 0) b.decliners++;
        else b.unchanged++;
      }
    }
    if (b.counted < 300) throw new Error("Too few S&P 500 quotes came back");
    return b;
  });
}
