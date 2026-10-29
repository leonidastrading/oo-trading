"use client";

import { useEffect, useState, type ReactNode } from "react";

export interface Panel {
  id: string;
  label: string;
  node: ReactNode;
}

/** Order ids by a saved list; panels missing from it keep their default place at the end. */
export function ordered<T extends { id: string }>(items: T[], saved: string[]): T[] {
  const rank = new Map(saved.map((id, i) => [id, i]));
  return items
    .map((it, i) => ({ it, r: rank.has(it.id) ? rank.get(it.id)! : saved.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.it);
}

/**
 * Panels the viewer can reorder: while `editing`, a bar on each panel lets you drag it (desktop)
 * or move it up/down (touch). The order is remembered on this device.
 */
export function Arrangeable({ storageKey, panels, editing }: { storageKey: string; panels: Panel[]; editing: boolean }) {
  const [order, setOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const v = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        if (Array.isArray(v)) setOrder(v.filter((x): x is string => typeof x === "string"));
      } catch {}
    });
  }, [storageKey]);

  const list = ordered(panels, order);
  const save = (ids: string[]) => {
    setOrder(ids);
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {}
  };
  const move = (id: string, to: number) => {
    const ids = list.map((p) => p.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    save(ids);
  };

  return (
    <div className="space-y-5">
      {editing && order.length > 0 && (
        <div className="flex justify-end">
          <button onClick={() => save([])} className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
            Reset layout
          </button>
        </div>
      )}
      {list.map((p, i) => (
        <div
          key={p.id}
          onDragOver={(e) => {
            if (!editing || !dragging) return;
            e.preventDefault();
            setOver(p.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragging && dragging !== p.id) move(dragging, list.findIndex((x) => x.id === p.id));
            setDragging(null);
            setOver(null);
          }}
          className={editing ? `rounded-2xl border-2 border-dashed p-2 ${over === p.id && dragging !== p.id ? "border-accent" : "border-border"}` : undefined}
        >
          {editing && (
            <div
              draggable
              onDragStart={(e) => {
                setDragging(p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              className="mb-2 flex cursor-grab items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm active:cursor-grabbing"
            >
              <span aria-hidden className="text-muted">
                ⠿
              </span>
              <span className="font-semibold">{p.label}</span>
              <span className="ml-auto flex gap-1">
                <button onClick={() => move(p.id, i - 1)} disabled={i === 0} aria-label={`Move ${p.label} up`} className="rounded border border-border px-2 disabled:opacity-30">
                  ▲
                </button>
                <button
                  onClick={() => move(p.id, i + 1)}
                  disabled={i === list.length - 1}
                  aria-label={`Move ${p.label} down`}
                  className="rounded border border-border px-2 disabled:opacity-30"
                >
                  ▼
                </button>
              </span>
            </div>
          )}
          <div className={editing ? "pointer-events-none max-h-48 overflow-hidden opacity-70" : undefined}>{p.node}</div>
        </div>
      ))}
    </div>
  );
}
