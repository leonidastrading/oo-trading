"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface PollMeta {
  pollMs: number | null;
}

/**
 * Fetch `url` now and then every `data.meta.pollMs` while the tab is visible.
 * The server decides the interval (market hours) so all clients follow the same rules.
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

    const load = async (force = false) => {
      if (timer) clearTimeout(timer);
      setLoading(true);
      try {
        const res = await fetch(force ? `${url}?force=1` : url, { cache: "no-store" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        if (cancelled) return;
        setData(json);
        setError(null);
        pollMs = json.meta.pollMs;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (pollMs && document.visibilityState === "visible") timer = setTimeout(() => load(), pollMs);
        }
      }
    };
    loadRef.current = load;

    const onVis = () => {
      if (document.visibilityState === "visible") load();
      else if (timer) clearTimeout(timer);
    };
    load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      if (timer) clearTimeout(timer);
    };
  }, [url, router]);

  return { data, error, loading, refresh: () => loadRef.current(true) };
}
