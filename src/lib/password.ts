// Dashboard password: a scrypt hash in Redis once changed in Settings,
// otherwise the DASHBOARD_PASSWORD env var.
import "server-only";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { kv } from "./kv";
import { SESSIONS_VALID_AFTER_KEY } from "./sessionEpoch";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY = "auth:password";
const MAX_FAILURES = 5; // per 15 minutes, across all clients
export const MIN_PASSWORD_LENGTH = 12;

interface StoredPassword {
  hash: string; // scrypt$<salt b64>$<hash b64>
  changedAt: number;
}

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyHash(pw: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

function sameString(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

async function stored(): Promise<StoredPassword | null> {
  try {
    return await kv().get<StoredPassword>(KEY);
  } catch {
    return null; // Redis not configured yet: fall back to the env var
  }
}

export async function checkPassword(pw: string): Promise<boolean> {
  const s = await stored();
  if (s) return verifyHash(pw, s.hash);
  const env = process.env.DASHBOARD_PASSWORD;
  return !!env && sameString(pw, env);
}

/** Shared brute-force guard for sign-in and password changes. */
export async function tooManyFailures(record: boolean): Promise<boolean> {
  try {
    const key = `auth:failures:${Math.floor(Date.now() / 900_000)}`;
    if (record) return (await kv().incr(key, 960)) > MAX_FAILURES;
    return ((await kv().get<number>(key)) ?? 0) >= MAX_FAILURES;
  } catch {
    return false;
  }
}

/** Store a new password and invalidate every existing session. */
export async function setPassword(pw: string): Promise<void> {
  const now = Date.now();
  await kv().set(KEY, { hash: await hashPassword(pw), changedAt: now } satisfies StoredPassword);
  await kv().set(SESSIONS_VALID_AFTER_KEY, now);
}

export async function passwordChangedAt(): Promise<number | null> {
  return (await stored())?.changedAt ?? null;
}
