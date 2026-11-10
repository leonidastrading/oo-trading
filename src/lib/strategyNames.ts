// Display names for the book strategies. The canonical names (scorecard STRATEGIES, plus "Dip" and "3 Delta") stay the
// internal keys; the viewer can rename how each one is shown (Settings → Strategy names).
import { STRATEGIES } from "./scorecard";

export const NAMEABLE = [...STRATEGIES, "Dip", "3 Delta"];
export const MAX_NAME = 24;

/** Trim, drop control characters and cap the length; "" means "use the default". */
export function cleanName(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME) : "";
}
