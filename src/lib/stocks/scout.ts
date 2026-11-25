import "server-only";
import { cardToPrefill, type CardPrefill } from "./scoutCard";

const BASE = (process.env.SCOUT_BASE_URL ?? "https://trend-scout-livid.vercel.app").replace(/\/$/, "");

const MOCK_CARD = {
  id: 246, ticker: "AAPL", direction: "long", target: 230,
  thesis: "Services margin expansion is not in the numbers yet, re-rating within 90 days.",
  invalidation: "Services growth below 10% in the next print",
  variantPerception: { market: "Hardware cycle is all that matters", mine: "Services mix drives the multiple", because: "Services gross margin up 3 quarters running" },
  catalyst: { text: "Fiscal Q1 earnings", date: "late January 2027" },
  stage: "1 Recognition", crowding: "normal", sectorEtf: "XLK",
};

export type CardResult = { ok: true; prefill: CardPrefill; raw: unknown } | { ok: false; error: string };

/** Read one Trend Scout card (read-only; the token never leaves the server). */
export async function fetchCard(idRaw: unknown): Promise<CardResult> {
  const id = String(idRaw ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,9}$/.test(id)) return { ok: false, error: "Card number is required (digits only, e.g. 246)" };
  let raw: unknown;
  if (process.env.SCHWAB_MOCK === "1") raw = id === "404" ? null : { ...MOCK_CARD, id: Number(id), ticker: ({ "247": "NVDA", "248": "GME", "249": "SMH", "250": "TSLA" } as Record<string, string>)[id] ?? MOCK_CARD.ticker };
  else {
    const token = process.env.SCOUT_API_TOKEN;
    if (!token) return { ok: false, error: "SCOUT_API_TOKEN isn't set on the server" };
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/cards/${id}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      return { ok: false, error: `Trend Scout didn't answer: ${(e as Error).message}` };
    }
    if (res.status === 404) return { ok: false, error: `Trend Scout has no card ${id}` };
    if (!res.ok) return { ok: false, error: `Trend Scout answered ${res.status} for card ${id}` };
    raw = await res.json().catch(() => null);
  }
  if (!raw) return { ok: false, error: `Trend Scout has no card ${id}` };
  const prefill = cardToPrefill(raw, id);
  if (!prefill) return { ok: false, error: `Card ${id} has no ticker` };
  prefill.cardUrl ??= `${BASE}/cards/${id}`;
  return { ok: true, prefill, raw };
}
