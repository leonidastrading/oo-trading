"use client";

import { useEffect, useState } from "react";

/** Settings toggle: Live and Today show option positions only, or every holding in the account. */
export function OptionsOnlySetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/settings/options-only", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { optionsOnly?: boolean }) => setOn(j.optionsOnly ?? true))
      .catch(() => setMsg("Could not load the setting"));
  }, []);
  async function toggle(v: boolean) {
    setOn(v);
    setMsg(null);
    const res = await fetch("/api/settings/options-only", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionsOnly: v }),
    });
    setMsg(res.ok ? "Saved — Live and Today update on their next refresh." : `Save failed (${res.status})`);
  }
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on ?? true} disabled={on === null} onChange={(e) => toggle(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        <span className="text-ink">Show option positions only</span>
      </label>
      <p className="text-xs text-muted">
        On Live and Today, leave out cash-like holdings such as money-market ETFs (SGOV, USFR): they don&apos;t count in the Open P/L, the
        position counts or Other positions. Your account balances aren&apos;t affected.
      </p>
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}
