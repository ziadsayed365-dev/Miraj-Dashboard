import "server-only";
import crypto from "crypto";
import { supabase } from "@/lib/supabase";

export const SESSION_COOKIE_NAME = "miraj_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type Role = "owner" | "staff";

// Pages each role may visit. Owner is unrestricted (checked separately).
export const STAFF_ALLOWED_PATHS = ["/", "/products", "/expense-analysis", "/bosta", "/print/income-statement"];

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Database-backed accounts (managed from /settings) are checked first;
// falls back to the original .env.local owner credentials so the owner
// can never be fully locked out if something goes wrong with the users
// table.
export async function resolveRole(username: string, password: string): Promise<Role | null> {
  const { data: user, error } = await supabase
    .from("users")
    .select("role, password_hash")
    .eq("username", username)
    .maybeSingle();

  if (!error && user && verifyPassword(password, user.password_hash)) {
    return user.role as Role;
  }

  const ownerUser = process.env.OWNER_USERNAME;
  const ownerPass = process.env.OWNER_PASSWORD;
  if (ownerUser && ownerPass && username === ownerUser && password === ownerPass) return "owner";
  return null;
}

// Token = "<role>.<expiry epoch ms>.<hmac signature>" - never stores the
// raw password, just proves whoever issued it knew SESSION_SECRET.
export function createSessionToken(role: Role, secret: string): string {
  const expiry = String(Date.now() + SESSION_DURATION_MS);
  const payload = `${role}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string | undefined): Role | null {
  if (!token || !secret) return null;
  const [role, expiry, signature] = token.split(".");
  if (!role || !expiry || !signature) return null;
  if (role !== "owner" && role !== "staff") return null;
  if (Date.now() > Number(expiry)) return null;

  const expected = sign(`${role}.${expiry}`, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return null;
  return crypto.timingSafeEqual(expectedBuf, actualBuf) ? (role as Role) : null;
}
