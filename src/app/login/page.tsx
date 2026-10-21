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
          {error === "AccessDenied" ? "That account is not allowed." : error === "CredentialsSignin" ? "Wrong email or password." : "Sign-in failed. Try again."}
        </p>
      )}
      <div className="space-y-3">
        {providers?.some((p) => p.id === "credentials") && (
          <form
            className="space-y-3 text-left"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              signIn("credentials", { email: f.get("email"), password: f.get("password"), callbackUrl });
            }}
          >
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="Email"
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-ink placeholder:text-muted"
            />
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Password"
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-ink placeholder:text-muted"
            />
            <button type="submit" className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-black">
              Sign in
            </button>
          </form>
        )}
        {providers?.filter((p) => p.id !== "credentials").map((p) => (
          <button
            key={p.id}
            onClick={() => signIn(p.id, { callbackUrl })}
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 font-semibold hover:bg-surface-2"
          >
            Continue with {p.name}
          </button>
        ))}
        {providers && !providers.length && (
          <p className="text-sm text-warn">No login method configured. Set DASHBOARD_PASSWORD (or GitHub/Google OAuth keys).</p>
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
