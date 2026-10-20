// Schwab OAuth 2 (authorization code) + token storage/refresh in KV.
import "server-only";
import { KEYS, kv } from "../kv";

const OAUTH = "https://api.schwabapi.com/v1/oauth";
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const REFRESH_EARLY_MS = 120_000;

export interface SchwabTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  /** When the user last completed the browser login; the refresh token dies ~7 days later. */
  refreshIssuedAt: number;
  updatedAt: number;
  needsReconnect?: boolean;
  lastError?: string;
}

export class SchwabAuthError extends Error {}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new SchwabAuthError(`Missing env var ${name}`);
  return v;
}

export function authorizeUrl(state: string): string {
  const u = new URL(`${OAUTH}/authorize`);
  u.searchParams.set("client_id", env("SCHWAB_CLIENT_ID"));
  u.searchParams.set("redirect_uri", env("SCHWAB_REDIRECT_URI"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(body: Record<string, string>) {
  const basic = Buffer.from(`${env("SCHWAB_CLIENT_ID")}:${env("SCHWAB_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new SchwabAuthError(`Schwab token endpoint ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function exchangeCode(code: string): Promise<SchwabTokens> {
  const now = Date.now();
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: env("SCHWAB_REDIRECT_URI") });
  if (!t.refresh_token) throw new SchwabAuthError("Schwab did not return a refresh token");
  const tokens: SchwabTokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: now + t.expires_in * 1000,
    refreshIssuedAt: now,
    updatedAt: now,
  };
  await kv().set(KEYS.tokens, tokens);
  await kv().del(KEYS.accountHash, KEYS.backoff);
  return tokens;
}

export async function loadTokens(): Promise<SchwabTokens | null> {
  if (process.env.SCHWAB_MOCK === "1" && !process.env.VERCEL) {
    const now = Date.now();
    return { accessToken: "mock", refreshToken: "mock", accessExpiresAt: now + 1_800_000, refreshIssuedAt: now - 5.5 * 86_400_000, updatedAt: now };
  }
  return kv().get<SchwabTokens>(KEYS.tokens);
}

/** Returns a valid access token, refreshing it (once, across instances) when close to expiry. */
export async function getAccessToken(force = false): Promise<string> {
  const store = kv();
  let tokens = await loadTokens();
  if (!tokens) throw new SchwabAuthError("Schwab is not connected");
  if (tokens.needsReconnect) throw new SchwabAuthError("Schwab login expired — reconnect in Settings");
  if (!force && tokens.accessExpiresAt - Date.now() > REFRESH_EARLY_MS) return tokens.accessToken;
  if (Date.now() > tokens.refreshIssuedAt + REFRESH_TOKEN_TTL_MS) {
    await store.set(KEYS.tokens, { ...tokens, needsReconnect: true, lastError: "Refresh token expired" });
    throw new SchwabAuthError("Schwab refresh token expired — reconnect in Settings");
  }

  const gotLock = await store.set(KEYS.refreshLock, 1, { px: 10_000, nx: true });
  if (!gotLock) {
    // Another request is refreshing; wait briefly for it.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      tokens = await loadTokens();
      if (tokens && tokens.accessExpiresAt - Date.now() > REFRESH_EARLY_MS) return tokens.accessToken;
    }
    if (tokens && tokens.accessExpiresAt > Date.now()) return tokens.accessToken;
    throw new SchwabAuthError("Timed out waiting for token refresh");
  }
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    const now = Date.now();
    const next: SchwabTokens = {
      ...tokens,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? tokens.refreshToken,
      accessExpiresAt: now + t.expires_in * 1000,
      updatedAt: now,
      lastError: undefined,
    };
    await store.set(KEYS.tokens, next);
    return next.accessToken;
  } catch (e) {
    const msg = (e as Error).message;
    // 400/401 from the token endpoint means the refresh token is dead.
    const dead = /token endpoint 40[01]/.test(msg);
    await store.set(KEYS.tokens, { ...tokens, needsReconnect: dead || tokens.needsReconnect, lastError: msg });
    throw new SchwabAuthError(dead ? "Schwab login expired — reconnect in Settings" : msg);
  } finally {
    await store.del(KEYS.refreshLock);
  }
}

export interface TokenStatus {
  connected: boolean;
  needsReconnect: boolean;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  refreshDaysLeft: number | null;
  connectedAt: number | null;
  warn: boolean;
  lastError: string | null;
}

export function tokenStatusFrom(tokens: SchwabTokens | null, now = Date.now()): TokenStatus {
  if (!tokens) {
    return {
      connected: false, needsReconnect: true, accessExpiresAt: null, refreshExpiresAt: null,
      refreshDaysLeft: null, connectedAt: null, warn: true, lastError: null,
    };
  }
  const refreshExpiresAt = tokens.refreshIssuedAt + REFRESH_TOKEN_TTL_MS;
  const daysLeft = (refreshExpiresAt - now) / 86_400_000;
  const expired = daysLeft <= 0 || !!tokens.needsReconnect;
  return {
    connected: !expired,
    needsReconnect: expired,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt,
    refreshDaysLeft: Math.max(0, Math.round(daysLeft * 10) / 10),
    connectedAt: tokens.refreshIssuedAt,
    warn: expired || daysLeft < 2,
    lastError: tokens.lastError ?? null,
  };
}

export async function tokenStatus(): Promise<TokenStatus> {
  return tokenStatusFrom(await loadTokens());
}
