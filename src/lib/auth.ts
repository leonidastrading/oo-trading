import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

/** Comma-separated list in ALLOWED_EMAIL (normally exactly one address). */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.ALLOWED_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

const providers: NextAuthOptions["providers"] = [];
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
