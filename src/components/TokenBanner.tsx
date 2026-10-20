"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { TokenStatus } from "@/lib/schwab/tokens";

/** Global warning when the Schwab refresh token is about to expire (< 2 days) or is gone. */
export function TokenBanner() {
  const path = usePathname();
  const [token, setToken] = useState<TokenStatus | null>(null);
  useEffect(() => {
    if (path === "/login") return;
    fetch("/api/schwab/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setToken(j.token))
      .catch(() => {});
  }, [path]);
  if (!token || !token.warn || path === "/login") return null;
  const msg = token.needsReconnect
    ? "Schwab is disconnected or the login expired."
    : `Schwab login expires in ${token.refreshDaysLeft} day${token.refreshDaysLeft === 1 ? "" : "s"}.`;
  return (
    <div role="alert" className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-warn">
      <div className="mx-auto flex max-w-6xl items-center gap-2">
        <span aria-hidden>⚠</span>
        <span>{msg}</span>
        <Link href="/api/schwab/authorize" prefetch={false} className="ml-auto font-semibold underline">
          Reconnect Schwab
        </Link>
      </div>
    </div>
  );
}
