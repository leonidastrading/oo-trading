import { describe, expect, it } from "vitest";
import { cleanSmas, smaColors } from "../src/lib/chartSmas";

describe("chart SMA setting", () => {
  it("keeps whole periods in range, sorted, without repeats", () => {
    expect(cleanSmas([10, "5", 5, 0, 1.5, 999, 200])).toEqual([5, 10, 200]);
    expect(cleanSmas([])).toEqual([]);
    expect(cleanSmas("x")).toBeNull();
    expect(cleanSmas([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])!.length).toBe(8);
  });
  it("gives every line a colour, the original four unchanged", () => {
    const c = smaColors([5, 20, 50]);
    expect(c.map((x) => x.n)).toEqual([5, 20, 50]);
    expect(c[0].color).toBe("rgba(57, 135, 229, 0.5)");
    expect(c[1].color).not.toBe(c[2].color);
  });
});
