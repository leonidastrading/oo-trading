"use client";

import { useEffect, useState } from "react";

// Viewer-chosen display names for the book strategies, loaded once per page and shared by every component.
type Names = Record<string, string>;
let cache: Names | null = null;
let pending: Promise<Names> | null = null;
const listeners = new Set<(n: Names) => void>();

function load(): Promise<Names> {
  pending ??= fetch("/api/strategy-names", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { names: {} }))
    .then((j: { names?: Names }) => (cache = j.names ?? {}))
    .catch(() => (cache = {}));
  return pending;
}

/** Tell every mounted component about new names (after Settings saves them). */
export function publishStrategyNames(names: Names) {
  cache = names;
  pending = Promise.resolve(names);
  for (const l of listeners) l(names);
}

/** Display name of a canonical strategy name (unchanged if not renamed). */
export const displayName = (names: Names, s: string) => names[s] ?? s;

/** The viewer's strategy renames (canonical → display); stable until they change. */
export function useStrategyNames(): Names {
  const [names, setNames] = useState<Names>(cache ?? {});
  useEffect(() => {
    listeners.add(setNames);
    if (!cache) void load().then(setNames);
    return () => {
      listeners.delete(setNames);
    };
  }, []);
  return names;
}
