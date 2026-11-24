// Which daily-close SMAs the main (SPX) chart draws. Pure, shared by the settings route and the chart.

export const DEFAULT_SMAS = [4, 5, 8, 10];
export const SMA_CHOICES = [4, 5, 8, 10, 20, 50, 100, 200];
export const SMA_MIN = 2;
export const SMA_MAX = 240; // the chart loads a year of daily closes
export const SMA_LIMIT = 8;

/** Whole periods within range, no repeats, ascending, at most SMA_LIMIT. Null if the input isn't a list. */
export function cleanSmas(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const set = new Set<number>();
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= SMA_MIN && n <= SMA_MAX) set.add(n);
  }
  return [...set].sort((a, b) => a - b).slice(0, SMA_LIMIT);
}

const FIXED: Record<number, string> = {
  4: "rgba(224, 183, 59, 0.45)",
  5: "rgba(57, 135, 229, 0.5)",
  8: "rgba(176, 132, 232, 0.5)",
  10: "rgba(200, 200, 195, 0.4)",
};
const EXTRA = ["rgba(63, 181, 157, 0.55)", "rgba(230, 103, 103, 0.55)", "rgba(240, 150, 70, 0.55)", "rgba(120, 200, 240, 0.55)", "rgba(220, 120, 200, 0.55)"];

/** Line colour for each period: the original four keep theirs; others take the next spare colour. */
export function smaColors(periods: number[]): { n: number; color: string }[] {
  let i = 0;
  return periods.map((n) => ({ n, color: FIXED[n] ?? EXTRA[i++ % EXTRA.length] }));
}
