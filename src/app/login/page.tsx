"use client";

import { getProviders, signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function LoginInner() {
  const params = useSearchParams();
  const error = params.get("error");
  const callbackUrl = params.get("callbackUrl") ?? "/";
  const [providers, setProviders] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    getProviders().then((p) => setProviders(p ? Object.values(p) : []));
  }, []);
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-6 text-center">
      <h1 className="text-2xl font-bold text-accent">OO Trading</h1>
      <p className="text-sm text-ink-2">Private dashboard. Sign in with the allowed account.</p>
      {error && (
        <p role="alert" className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">
          {error === "AccessDenied" ? "That account is not allowed." : "Sign-in failed. Try again."}
        </p>
      )}
      <div className="space-y-3">
        {providers?.map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id, { callbackUrl })}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 font-semibold hover:bg-surface-2"
          >
            Continue with {p.name}
          </button>
        ))}
        {providers && !providers.length && (
          <p className="text-sm text-warn">No login provider configured. Set GITHUB_ID/GITHUB_SECRET or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.</p>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
