// Bearer-token check for the routes that live outside the NextAuth session (ingest, advisor export).
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * True when the request carries `Authorization: Bearer <expected>`. Both sides are hashed before the
 * timing-safe compare so the comparison takes the same time whatever the given token's length.
 */
export function bearerMatches(req: NextRequest, expected: string | undefined): boolean {
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!expected || !given) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(expected), h(given));
}
