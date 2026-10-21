import { NextResponse } from "next/server";
import { KV_MISSING, kvConfigured } from "./kv";

/** 503 with a setup message when the Redis store isn't connected yet. */
export function requireKv(): NextResponse | null {
  return kvConfigured() ? null : NextResponse.json({ error: KV_MISSING }, { status: 503 });
}
