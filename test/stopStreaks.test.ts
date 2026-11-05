import { describe, expect, it } from "vitest";
import type { SimTrade } from "@/lib/allocSim";
import { stopStreaks } from "@/components/StopStreaks";

const tr = (strategy: string, i: number, stopped: boolean) => ({ strategy, open: `2026-01-${String(i).padStart(2, "0")} 13:30:00`, stopped }) as SimTrade;

describe("stopStreaks", () => {
  it("counts back-to-back stops per strategy and sorts the worst first", () => {
    // A: S S S W S S W W  → runs 3 and 2; B: S W S W → runs 1, 1
    const a = [1, 1, 1, 0, 1, 1, 0, 0].map((s, i) => tr("A", i + 1, !!s));
    const b = [1, 0, 1, 0].map((s, i) => tr("B", i + 1, !!s));
    const [ra, rb] = stopStreaks([...b, ...a]);
    expect(ra.strategy).toBe("A");
    expect(ra.longest).toBe(3);
    expect(ra.byN[2]).toEqual({ runs: 2, pct: 5 / 8 });
    expect(ra.byN[3]).toEqual({ runs: 1, pct: 3 / 8 });
    expect(ra.byN[4].runs).toBe(0);
    expect(rb.longest).toBe(1);
    expect(rb.byN[2].runs).toBe(0);
  });
});
