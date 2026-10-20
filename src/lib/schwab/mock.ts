// Local-only fixtures (SCHWAB_MOCK=1, never on Vercel) so the UI can be previewed without Schwab.
import { etMidnightUtc, todayET, addDays } from "../time";

export const mockEnabled = () => process.env.SCHWAB_MOCK === "1" && !process.env.VERCEL;

const yymmdd = (d: string) => d.slice(2).replace(/-/g, "");
const sym = (exp: string, pc: "P" | "C", k: number) => `SPXW  ${yymmdd(exp)}${pc}${String(k * 1000).padStart(8, "0")}`;

export function mockResponse(path: string): unknown {
  const today = todayET();
  const in2 = addDays(today, 2);
  const spot = 7718.4 + Math.sin(Date.now() / 60_000) * 3;

  if (path.endsWith("/accountNumbers")) return [{ accountNumber: "12349061", hashValue: "MOCKHASH" }];

  if (path.startsWith("/marketdata/v1/quotes")) {
    return { $SPX: { quote: { lastPrice: spot, netChange: spot - 7731.2, netPercentChange: ((spot - 7731.2) / 7731.2) * 100, closePrice: 7731.2 } } };
  }

  if (path.endsWith("/transactions")) {
    const t0 = etMidnightUtc(today).getTime();
    const at = (h: number, m: number) => new Date(t0 + (h * 60 + m) * 60_000).toISOString();
    const tx = (id: number, time: string, symbol: string, amount: number, price: number, effect: string) => ({
      activityId: id, time, type: "TRADE", orderId: 1000 + Math.floor(id / 10),
      netAmount: -amount * price * 100 - 0.66 * Math.abs(amount),
      transferItems: [
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, cost: -0.66 * Math.abs(amount), feeType: "COMMISSION" },
        { instrument: { assetType: "OPTION", symbol }, amount, price, cost: -amount * price * 100, positionEffect: effect },
      ],
    });
    return [
      tx(10, at(10, 5), sym(today, "P", 7700), -10, 3.1, "OPENING"),
      tx(11, at(10, 5), sym(today, "P", 7650), 10, 0.6, "OPENING"),
      tx(20, at(13, 40), sym(today, "P", 7700), 10, 0.9, "CLOSING"),
      tx(21, at(13, 40), sym(today, "P", 7650), -10, 0.05, "CLOSING"),
    ];
  }

  // Account with positions (Schwab nets identical symbols).
  const book: [string, "P" | "C", number, number, number][] = [
    [today, "P", 7580, 18, 0.07], [today, "P", 7590, 18, 0.07], [today, "P", 7670, 9, 0.17],
    [today, "P", 7675, 18, 0.27], [today, "P", 7680, -18, 0.41], [today, "P", 7690, -18, 0.44],
    [today, "P", 7715, -18, 6.0], [today, "P", 7720, -36, 4.69], [today, "P", 7745, 9, 32.43],
    [today, "P", 7750, 18, 28.885], [today, "C", 7740, -18, 0.31], [today, "C", 7755, -18, 0.41],
    [today, "C", 7840, 18, 0.03], [today, "C", 7855, 18, 0.05],
    [in2, "P", 7600, -10, 4.1], [in2, "P", 7525, 10, 1.2],
  ];
  const positions = book.map(([exp, pc, k, qty, avg]) => {
    const intrinsic = pc === "P" ? Math.max(k - spot, 0) : Math.max(spot - k, 0);
    const mark = intrinsic + (exp === today ? 0.3 : 4) * Math.exp(-Math.abs(k - spot) / 40);
    const mv = qty * mark * 100;
    return {
      longQuantity: qty > 0 ? qty : 0, shortQuantity: qty < 0 ? -qty : 0, averagePrice: avg, marketValue: mv,
      currentDayProfitLoss: Math.round((mv - qty * avg * 100) * 0.4),
      [qty > 0 ? "longOpenProfitLoss" : "shortOpenProfitLoss"]: mv - qty * avg * 100,
      instrument: { assetType: "OPTION", symbol: sym(exp, pc, k), putCall: pc === "P" ? "PUT" : "CALL", underlyingSymbol: "$SPX" },
    };
  });
  return {
    securitiesAccount: {
      type: "MARGIN", accountNumber: "12349061", positions,
      initialBalances: { liquidationValue: 412_000 },
      currentBalances: { liquidationValue: 414_695, buyingPower: 188_250, cashBalance: 250_000 },
    },
  };
}
