"use client";

import { useState } from "react";
import { parseOOTradeLog } from "@/lib/ooCsv";

interface FileResult {
  name: string;
  parsed: number;
  added: number;
  duplicates: number;
  errors: string[];
  done: boolean;
}

const CHUNK = 1000;

/** OO trade-log CSV upload (parsed in the browser, de-duplicated on the server). */
export function UploadTrades({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const out: FileResult[] = [];
    for (const file of Array.from(files)) {
      const r: FileResult = { name: file.name, parsed: 0, added: 0, duplicates: 0, errors: [], done: false };
      out.push(r);
      setResults([...out]);
      try {
        const { trades, errors, duplicatesInFile } = parseOOTradeLog(await file.text(), file.name.replace(/\.csv$/i, ""));
        r.parsed = trades.length;
        r.duplicates = duplicatesInFile;
        r.errors = errors;
        for (let i = 0; i < trades.length; i += CHUNK) {
          const res = await fetch("/api/oo/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trades: trades.slice(i, i + CHUNK), file: file.name }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          r.added += j.added;
          r.duplicates += j.duplicates;
          if (j.invalid) r.errors.push(`${j.invalid} rows rejected by server validation`);
        }
      } catch (e) {
        r.errors.push((e as Error).message);
      }
      r.done = true;
      setResults([...out]);
    }
    setBusy(false);
    onDone?.();
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="sr-only">Choose OO trade-log CSV files</span>
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={busy}
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
          className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-4 file:py-2 file:text-ink"
        />
      </label>
      {results.map((r) => (
        <div key={r.name} className={`rounded-lg bg-surface-2 text-sm ${compact ? "p-2" : "p-3"}`}>
          <div className="font-semibold">{r.name}</div>
          <div className="text-ink-2">
            {r.done ? "✓" : "…"} parsed {r.parsed} · added {r.added} · duplicates {r.duplicates}
          </div>
          {r.errors.slice(0, 5).map((e) => (
            <div key={e} className="text-loss">
              {e}
            </div>
          ))}
          {r.errors.length > 5 && <div className="text-loss">…and {r.errors.length - 5} more</div>}
        </div>
      ))}
    </div>
  );
}
