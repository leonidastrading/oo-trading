// Pure roll-up of the open stock positions for the Portfolio stats section.

export interface PositionIn {
  ticker: string;
  long: boolean;
  /** Market value of the position, $ (always positive). */
  value: number;
  /** Today's % change of the stock (null when unknown). */
  dayPct: number | null;
  sector: string;
}

export interface SectorRow {
  sector: string;
  positions: number;
  long: number;
  short: number;
  total: number;
  /** Share of all invested money, %. */
  pctOfInvested: number;
  /** Share of the sector's money that is short, %. */
  shortPct: number;
}

export interface PortfolioStats {
  positions: number;
  long: number;
  short: number;
  invested: number;
  longCount: number;
  shortCount: number;
  /** Holdings by today's move of the stock itself. */
  advancers: number;
  decliners: number;
  unchanged: number;
  /** Holdings moving in the position's favour today (longs up, shorts down). */
  inFavour: number;
  against: number;
  sectors: SectorRow[];
}

export const UNCLASSIFIED = "ETF / not classified";

export function portfolioStats(ps: PositionIn[]): PortfolioStats {
  const s: PortfolioStats = { positions: ps.length, long: 0, short: 0, invested: 0, longCount: 0, shortCount: 0, advancers: 0, decliners: 0, unchanged: 0, inFavour: 0, against: 0, sectors: [] };
  const bySector = new Map<string, SectorRow>();
  for (const p of ps) {
    if (p.long) {
      s.long += p.value;
      s.longCount++;
    } else {
      s.short += p.value;
      s.shortCount++;
    }
    if (p.dayPct !== null) {
      if (p.dayPct > 0) s.advancers++;
      else if (p.dayPct < 0) s.decliners++;
      else s.unchanged++;
      if (p.dayPct !== 0) {
        if (p.dayPct > 0 === p.long) s.inFavour++;
        else s.against++;
      }
    }
    const name = p.sector || UNCLASSIFIED;
    const row = bySector.get(name) ?? { sector: name, positions: 0, long: 0, short: 0, total: 0, pctOfInvested: 0, shortPct: 0 };
    row.positions++;
    if (p.long) row.long += p.value;
    else row.short += p.value;
    bySector.set(name, row);
  }
  s.invested = s.long + s.short;
  for (const r of bySector.values()) {
    r.total = r.long + r.short;
    r.pctOfInvested = s.invested ? (r.total / s.invested) * 100 : 0;
    r.shortPct = r.total ? (r.short / r.total) * 100 : 0;
  }
  s.sectors = [...bySector.values()].sort((a, b) => b.total - a.total);
  return s;
}
