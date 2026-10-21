import { createHash, timingSafeEqual } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedEmail } from "./allowed";

export { isAllowedEmail };

const MAX_FAILURES = 5; // per 15 minutes, across all clients

function samePassword(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function tooManyFailures(record: boolean): Promise<boolean> {
  try {
    const { kv } = await import("./kv");
    const key = `auth:failures:${Math.floor(Date.now() / 900_000)}`;
    if (record) return (await kv().incr(key, 960)) > MAX_FAILURES;
    return ((await kv().get<number>(key)) ?? 0) >= MAX_FAILURES;
  } catch {
    return false; // KV not configured yet; the password is long and random anyway
  }
}

const providers: NextAuthOptions["providers"] = [];
if (process.env.DASHBOARD_PASSWORD) {
  providers.push(
    CredentialsProvider({
      id: "credentials",
      name: "Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const expected = process.env.DASHBOARD_PASSWORD;
        if (!expected || !creds?.email || !creds.password) return null;
        if (await tooManyFailures(false)) return null;
        if (isAllowedEmail(creds.email) && samePassword(creds.password, expected)) {
          return { id: creds.email.toLowerCase(), email: creds.email.toLowerCase() };
        }
        await tooManyFailures(true);
        return null;
      },
    }),
  );
}
if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) {
  providers.push(GitHubProvider({ clientId: process.env.GITHUB_ID, clientSecret: process.env.GITHUB_SECRET }));
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }),
  );
}

export const authOptions: NextAuthOptions = {
  providers,
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 30 * 24 * 3600 },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async signIn({ user, profile, account }) {
      // Google: require a verified address.
      if (account?.provider === "google" && (profile as { email_verified?: boolean })?.email_verified === false) return false;
      return isAllowedEmail(user.email);
    },
  },
};
