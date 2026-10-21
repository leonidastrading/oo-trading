import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedEmail } from "./allowed";

export { isAllowedEmail };

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
        if (!creds?.email || !creds.password) return null;
        const { checkPassword, tooManyFailures } = await import("./password");
        if (await tooManyFailures(false)) return null;
        if (isAllowedEmail(creds.email) && (await checkPassword(creds.password))) {
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
    async jwt({ token, user }) {
      // Stamp the login time once; it survives token refreshes so a password
      // change (sessionsValidAfter) can revoke older sessions.
      if (user) token.authAt = Date.now();
      return token;
    },
  },
};
