/**
 * Trend Scout card -> Stock Trades form prefill. Pure (no I/O) so it can be unit-tested.
 * The card's field names are matched loosely (case and punctuation ignored, nested objects searched).
 */

export interface CardPrefill {
  cardId: string;
  cardUrl: string | null;
  ticker: string;
  direction: "long" | "short" | "";
  stop: string;
  target: string;
  days: string;
  thesis: string;
  invalidation: string;
  ideaNotes: string;
  becauseData: string;
  catalyst: string;
  catalystDate: string;
  priceImplies: string;
  stage: string;
  crowding: string;
  benchmark: string;
  /** A suggested entry price on the card, shown as a hint (the form still defaults to a market entry). */
  entryHint: string;
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every value in the card keyed by its normalised name, and by parent+name; shallow keys win. */
function index(card: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let level: { v: unknown; path: string }[] = [{ v: card, path: "" }];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: typeof level = [];
    for (const { v, path } of level) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const key = norm(k);
        if (!out.has(key)) out.set(key, val);
        if (path && !out.has(path + key)) out.set(path + key, val);
        next.push({ v: val, path: key });
      }
    }
    level = next;
  }
  return out;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join("; ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["text", "summary", "description", "value", "label", "name"]) if (typeof o[k] === "string") return (o[k] as string).trim();
  }
  return "";
}

function price(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? String(n < 1 ? Math.round(n * 10000) / 10000 : Math.round(n * 100) / 100) : "";
}

/** "10", 10, "2 weeks", "3-6 months" (takes the first number) -> whole days, 1–365. */
function days(v: unknown): string {
  const s = text(v).toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return "";
  const n = Number(m[1]);
  const mult = /month|mo\b/.test(s) ? 30 : /week|wk/.test(s) ? 7 : /year|yr/.test(s) ? 365 : 1;
  const d = Math.round(n * mult);
  return d >= 1 ? String(Math.min(d, 365)) : "";
}

const STAGE_WORDS = ["stealth", "recognition", "institutional", "mania", "unwind"];
function stage(v: unknown): string {
  const s = text(v).toLowerCase();
  const m = s.match(/[0-4]/);
  if (m) return m[0];
  const i = STAGE_WORDS.findIndex((w) => s.includes(w));
  return i >= 0 ? String(i) : "";
}

function crowding(v: unknown): string {
  const s = text(v).toLowerCase();
  if (/\b(high|crowded|extreme|hot)\b/.test(s)) return "high";
  if (/\b(low|quiet|uncrowded|cold)\b/.test(s)) return "low";
  if (/\b(normal|medium|moderate|average|neutral)\b/.test(s)) return "normal";
  return "";
}

export function cardToPrefill(card: unknown, cardId: string): CardPrefill | null {
  const ix = index(card);
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = ix.get(n);
      if (v !== undefined && v !== null && text(v) !== "") return v;
    }
    return undefined;
  };
  const cut = (v: unknown, max: number) => text(v).replace(/\s+/g, " ").slice(0, max);
  const ticker = text(pick("ticker", "symbol", "stock")).toUpperCase().replace(/^\$/, "");
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(ticker)) return null;
  const dirRaw = text(pick("direction", "side", "longshort", "bias", "position")).toLowerCase();
  const direction = /short|bear|sell/.test(dirRaw) ? "short" : /long|bull|buy/.test(dirRaw) ? "long" : "";
  const thesisText = text(pick("thesis", "summary", "pitch", "description", "idea"));
  const within = thesisText.match(/within\s+(?:the\s+next\s+)?(\d+\s*(?:trading\s+)?(?:days?|weeks?|months?))/i);
  const bench = text(pick("benchmark", "benchmarketf", "sectoretf", "etf")).toUpperCase();
  const url = text(pick("url", "cardurl", "link"));
  return {
    cardId,
    cardUrl: /^https:\/\//.test(url) ? url : null,
    ticker,
    direction,
    stop: price(pick("stop", "stopprice", "stoploss", "stoplossprice")),
    target: price(pick("target", "targetprice", "pricetarget", "takeprofit")),
    entryHint: price(pick("entry", "entryprice", "limit", "limitprice", "buyprice")),
    days: days(pick("days", "timeframedays", "holdingperioddays", "horizondays", "holddays", "timeframe", "holdingperiod", "horizon")) || (within ? days(within[1]) : ""),
    thesis: cut(pick("thesis", "summary", "pitch", "description", "idea"), 600),
    invalidation: cut(pick("invalidation", "whatprovesitwrong", "provesitwrong", "provedwrong", "killcriteria", "wrongif", "invalidatedif"), 400),
    ideaNotes: [
      ["Market believes", pick("marketbelieves", "marketview", "consensus", "consensusview", "variantperceptionmarket", "variantmarket")],
      ["I believe", pick("ibelieve", "myview", "variantview", "ourview", "variantperceptionmine", "variantperceptionme", "variantmine", "variantperceptionview")],
      ["", pick("notes", "note", "comment", "comments")],
    ]
      .filter(([, v]) => v !== undefined)
      .map(([l, v]) => (l ? `${l}: ${cut(v, 300)}` : cut(v, 400)))
      .join(" · ")
      .slice(0, 1000),
    becauseData: cut(pick("becausedata", "because", "becauseofthisdata", "evidence", "data", "variantperceptionbecause", "variantperceptiondata", "variantperceptionevidence"), 300),
    catalyst: cut(pick("catalyst", "catalysttext", "catalystdescription", "catalystevent"), 300),
    catalystDate: cut(pick("catalystdate", "catalystwindow", "catalystwhen", "catalysttiming"), 80),
    priceImplies: cut(pick("priceimplies", "pricedfor", "whatpriceimplies"), 300),
    stage: stage(pick("stage", "storystage")),
    crowding: crowding(pick("crowding", "crowdinglevel", "sentiment")),
    benchmark: /^[A-Z][A-Z0-9.\-/]{0,9}$/.test(bench) && bench !== "SPY" ? bench : "",
  };
}
