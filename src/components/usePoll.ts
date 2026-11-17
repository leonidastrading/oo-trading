"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { etParts } from "@/lib/time";

export interface PollMeta {
  pollMs: number | null;
}

/**
 * Outside market hours: re-check every 5 minutes (served from the server cache, no Schwab calls), but no
 * later than just after the next 9:30 ET open, so an open tab picks up the session right away.
 */
const IDLE_POLL_MS = 5 * 60_000;
function idleDelay(now = Date.now()): number {
  const p = etParts(now);
  const toOpen = (9 * 60 + 30 - p.minutesOfDay) * 60_000 - p.second * 1000 + 2_000;
  return toOpen > 0 && toOpen < IDLE_POLL_MS ? Math.max(5_000, toOpen) : IDLE_POLL_MS;
}
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Fetch `url` now and then every `data.meta.pollMs` while the tab is visible.
 * The server decides the interval (market hours) so all clients follow the same rules;
 * when it says "no polling" (market closed) we still check every minute so an open tab
 * notices the next session start.
 */
export function usePoll<T extends { meta: PollMeta }>(url: string) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollMs: number | null = null;
    let lastStart = 0;

    const load = async (force = false) => {
      if (timer) clearTimeout(timer);
      lastStart = Date.now();
      // Only a manual refresh shows "Refreshing…"; automatic polls run silently.
      if (force) setLoading(true);
      try {
        const res = await fetch(force ? `${url}?force=1` : url, {
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as T;
        if (cancelled) return;
        setData(json);
        setError(null);
        pollMs = json.meta.pollMs;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) {
          if (force) setLoading(false);
          if (document.visibilityState === "visible") timer = setTimeout(() => load(), pollMs ?? idleDelay());
        }
      }
    };
    loadRef.current = load;

    const onVis = () => {
      if (document.visibilityState === "visible") load();
      else if (timer) clearTimeout(timer);
    };
    // Returning to the app/tab, unlocking the device or reconnecting: refresh now.
    const onWake = () => {
      if (document.visibilityState === "visible" && Date.now() - lastStart > 5_000) load();
    };
    load();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    window.addEventListener("online", onWake);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
      window.removeEventListener("online", onWake);
      if (timer) clearTimeout(timer);
    };
  }, [url, router]);

  return { data, error, loading, refresh: () => loadRef.current(true) };
}
