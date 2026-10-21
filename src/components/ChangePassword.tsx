"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";
import { Banner } from "./StatusBar";

const MIN = 12;

export function ChangePassword() {
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const current = String(f.get("current") ?? "");
    const next = String(f.get("next") ?? "");
    if (next !== String(f.get("confirm") ?? "")) return setMsg({ tone: "error", text: "New passwords don't match." });
    if (next.length < MIN) return setMsg({ tone: "error", text: `Use at least ${MIN} characters.` });
    setBusy(true);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "error", text: j.error ?? `Failed (${res.status})` });
    setMsg({ tone: "info", text: "Password changed. Signing you out — sign in with the new password." });
    setTimeout(() => signOut({ callbackUrl: "/login" }), 1500);
  }

  const input = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-ink";
  return (
    <section className="card space-y-3 p-4">
      <h2 className="text-lg font-bold text-accent">Change password</h2>
      <p className="text-sm text-ink-2">At least {MIN} characters. Changing it signs out every device, including this one.</p>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <form onSubmit={submit} className="grid max-w-sm gap-2">
        <input name="current" type="password" autoComplete="current-password" placeholder="Current password" required className={input} />
        <input name="next" type="password" autoComplete="new-password" placeholder="New password" required minLength={MIN} className={input} />
        <input name="confirm" type="password" autoComplete="new-password" placeholder="Confirm new password" required minLength={MIN} className={input} />
        <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2 font-semibold text-black disabled:opacity-50">
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </section>
  );
}
