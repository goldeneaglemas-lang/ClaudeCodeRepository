// Customer sign-in with a code texted to their phone (PLAN.md §2, §6).
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";
import { smsProvider, usingTestSms } from "./sms";
import { MINUTE } from "./time";

export const SESSION_COOKIE = "ww_session";
export const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5; // wrong guesses per code
const MAX_CODES_PER_PHONE = 3; // per 15 minutes
const MAX_CODES_PER_IP = 10; // per hour

export class AuthError extends Error {
  constructor(
    readonly code: "too_many_codes" | "invalid_code" | "send_failed",
    message: string,
  ) {
    super(message);
  }
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set in production.");
  return "dev-only-auth-secret";
}

/** Keyed hash, so a leaked database doesn't reveal codes (only 1,000,000 possibilities). */
function hashCode(phone: string, code: string): string {
  return createHmac("sha256", authSecret()).update(`${phone}:${code}`).digest("hex");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Texts a 6-digit sign-in code. In test-SMS mode (no Twilio), the code is
 * returned so the page can show it; otherwise only the text has it.
 */
export async function sendLoginCode(phone: string, ip: string | null, now = new Date()): Promise<{ devCode?: string }> {
  const [byPhone, byIp] = await Promise.all([
    prisma.loginCode.count({ where: { phone, createdAt: { gt: new Date(now.getTime() - 15 * MINUTE) } } }),
    ip ? prisma.loginCode.count({ where: { ip, createdAt: { gt: new Date(now.getTime() - 60 * MINUTE) } } }) : 0,
  ]);
  if (byPhone >= MAX_CODES_PER_PHONE || byIp >= MAX_CODES_PER_IP) {
    throw new AuthError("too_many_codes", "Too many codes requested. Please wait a few minutes and try again.");
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await prisma.loginCode.create({
    data: { phone, ip, codeHash: hashCode(phone, code), expiresAt: new Date(now.getTime() + CODE_MINUTES * MINUTE), createdAt: now },
  });

  try {
    await smsProvider().send(phone, `Your Wag & Wash code is ${code}. It expires in ${CODE_MINUTES} minutes.`);
  } catch (e) {
    await prisma.loginCode.delete({ where: { id: row.id } }); // don't count a code that never arrived
    console.error("Couldn't send login code", e);
    throw new AuthError("send_failed", "We couldn't send a text to that number. Please check it and try again.");
  }
  return usingTestSms() ? { devCode: code } : {};
}

/** Checks the code and starts a session. Returns the cookie token. */
export async function verifyLoginCode(phone: string, code: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const invalid = new AuthError("invalid_code", "That code isn't right or has expired. Please try again or get a new code.");
  if (!/^\d{6}$/.test(code)) throw invalid;

  // Only the newest code counts, so an older one can't be guessed at alongside it.
  const latest = await prisma.loginCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) throw invalid;

  // Count the attempt first, atomically, so parallel guesses can't exceed the limit.
  const { count } = await prisma.loginCode.updateMany({
    where: { id: latest.id, attempts: { lt: MAX_ATTEMPTS }, consumedAt: null },
    data: { attempts: { increment: 1 } },
  });
  if (count === 0) throw invalid;

  const expected = Buffer.from(latest.codeHash, "hex");
  const actual = Buffer.from(hashCode(phone, code), "hex");
  if (!timingSafeEqual(expected, actual)) throw invalid;

  // Use the code up; if two correct submissions race, only one wins.
  const used = await prisma.loginCode.updateMany({ where: { id: latest.id, consumedAt: null }, data: { consumedAt: now } });
  if (used.count === 0) throw invalid;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * MINUTE);
  await prisma.customerSession.create({ data: { tokenHash: sha256(token), phone, expiresAt, createdAt: now, lastSeenAt: now } });
  return { token, expiresAt };
}

/** The signed-in phone number for a session token, or null. */
export async function phoneForToken(token: string | undefined | null, now = new Date()): Promise<string | null> {
  if (!token) return null;
  const session = await prisma.customerSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!session || session.expiresAt <= now) return null;
  return session.phone;
}

export async function endSession(token: string | undefined | null): Promise<void> {
  if (token) await prisma.customerSession.deleteMany({ where: { tokenHash: sha256(token) } });
}

/** Reads the session cookie from a request (for API routes). */
export function tokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function phoneFromRequest(request: Request): Promise<string | null> {
  return phoneForToken(tokenFromRequest(request));
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** The client's IP for rate limiting (first X-Forwarded-For entry behind a proxy). */
export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || null;
}

/**
 * Blocks requests that another website's page sent using this site's cookies.
 * Browsers always send Origin on cross-site POSTs.
 */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  const host = request.headers.get("host");
  return origin !== expected && !(host && new URL(origin).host === host);
}
