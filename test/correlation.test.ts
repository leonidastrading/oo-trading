import { describe, expect, it } from "vitest";
import type { SimTrade } from "@/lib/allocSim";
import { correlationMatrix } from "@/components/CorrelationMatrix";

const tr = (strategy: string, closeDate: string, plPerLot: number) => ({ strategy, closeDate, plPerLot }) as SimTrade;

describe("correlationMatrix", () => {
  it("is +1 for strategies that move together, −1 for opposites", () => {
    const days = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
    const pl = [100, -50, 30, -80];
    const trades = days.flatMap((d, i) => [tr("A", d, pl[i]), tr("B", d, pl[i] * 2), tr("C", d, -pl[i])]);
    const m = correlationMatrix(trades, ["A", "B", "C"]);
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][2]).toBeCloseTo(-1, 6);
    expect(m[1][1]).toBe(1);
  });
});
