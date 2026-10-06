import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'mb_admin';

export function createSessionToken(secret, clinicId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ c: clinicId, exp: now + SESSION_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSessionToken(secret, token, now = Date.now()) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > now ? { clinicId: data.c } : null;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
