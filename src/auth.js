// Auth done properly, with only Node built-ins:
// - Passwords are NEVER stored. We store scrypt hashes with a per-user random
//   salt; even someone with the database can't read a password.
// - Sessions are compact HMAC-signed tokens scoped to a role + identity.
import crypto from 'node:crypto';

const SECRET = process.env.APP_SECRET || 'dev-only-insecure-secret-change-me';
if (!process.env.APP_SECRET) {
  console.warn('[tabletap] APP_SECRET not set — using an insecure dev secret. Set APP_SECRET in production.');
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (d) => crypto.createHmac('sha256', SECRET).update(d).digest();

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ------------------------- password policy ---------------------------- */
// The most-used leaked passwords; lowercase compare.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'iloveyou1', 'admin123',
  'welcome1', 'welcome123', 'letmein1', 'sunshine1', 'princess1', 'football1',
  'monkey123', 'dragon123', 'master123', 'shadow123', 'superman1', 'baseball1',
  'abc12345', 'india123', 'abcd1234', 'pass1234', 'test1234', 'qwer1234',
]);
export function passwordIssue(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 72) return 'Password must be under 72 characters.';
  if (!/[A-Za-z]/.test(pw)) return 'Password must include letters.';
  if (!/[0-9]/.test(pw)) return 'Password must include at least one number.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common — pick something more unique.';
  return null;
}

/* ------------------------- password hashing --------------------------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return b64u(salt) + '.' + b64u(hash);
}
export function verifyPassword(password, stored) {
  const [saltB64, hashB64] = String(stored).split('.');
  if (!saltB64 || !hashB64) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), 32);
  return safeEqual(b64u(hash), hashB64);
}

/* --------------------------- session tokens --------------------------- */
function issue(payload, ttlSec) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return body + '.' + b64u(hmac('tok.' + body));
}
function verify(token, role) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, b64u(hmac('tok.' + body)))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p || p.role !== role || typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}
export const issueOwnerToken   = (ownerId)  => issue({ role: 'owner', oid: ownerId }, 60 * 60 * 24 * 7);
export const verifyOwnerToken  = (t)        => verify(t, 'owner');
export const issueKitchenToken = (venueId)  => issue({ role: 'kitchen', vid: venueId }, 60 * 60 * 12);
export const verifyKitchenToken= (t)        => verify(t, 'kitchen');
export const issuePlatformToken = ()        => issue({ role: 'platform' }, 60 * 60 * 12);
export const verifyPlatformToken= (t)       => verify(t, 'platform');

/* ---------------------------- table QR sigs --------------------------- */
export const signTable   = (venueId, table) => b64u(hmac('table:' + venueId + ':' + table));
export const verifyTable = (venueId, table, sig) => !!sig && safeEqual(signTable(venueId, table), sig);

/* ----------------------------- rate limit ----------------------------- */
const buckets = new Map();
export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { count: 1, reset: now + windowMs }); return { ok: true }; }
  if (b.count >= limit) return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  b.count += 1; return { ok: true };
}
setInterval(() => { const n = Date.now(); for (const [k, v] of buckets) if (n > v.reset) buckets.delete(k); }, 60_000).unref();
