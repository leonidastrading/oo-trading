"use client";

import { useCallback, useSyncExternalStore } from "react";

const EVENT = "oo-pref";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * A view preference (collapsed sections, sort order, chart timeframe) remembered in this browser across
 * reloads. `ok` rejects stored values that no longer make sense.
 */
export function usePref<T>(key: string, fallback: T, ok?: (v: unknown) => boolean): [T, (v: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  let value = fallback;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!ok || ok(parsed)) value = parsed as T;
    } catch {}
  }
  const set = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {}
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set];
}
