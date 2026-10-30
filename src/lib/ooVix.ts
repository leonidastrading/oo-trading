// Opening VIX per entry minute, stored apart from the trades (same for every strategy at that minute).
import "server-only";
import { KEYS, kv } from "./kv";
import type { OOTrade } from "./ooCsv";

export const minuteKey = (t: Pick<OOTrade, "dateOpened" | "timeOpened">) => `${t.dateOpened} ${t.timeOpened}`;

/** Remember the VIX readings these trades carry. */
export async function rememberVix(trades: OOTrade[]): Promise<void> {
  const fresh = new Map<string, number>();
  for (const t of trades) if (typeof t.vix === "number" && Number.isFinite(t.vix)) fresh.set(minuteKey(t), t.vix);
  if (fresh.size) await kv().hsetMany(KEYS.ooVix, [...fresh]);
}

/** Fill in missing VIX from the stored readings (in place). */
export async function fillVix(trades: OOTrade[]): Promise<void> {
  if (!trades.some((t) => typeof t.vix !== "number")) return;
  const known = await kv().hgetall<number>(KEYS.ooVix);
  for (const t of trades) {
    if (typeof t.vix === "number") continue;
    const v = known[minuteKey(t)];
    if (typeof v === "number") t.vix = v;
  }
}
