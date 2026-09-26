// Sign-in with a user from the users table (managed on the Users & roles screen).
//
// Passwords are never stored - only scrypt hashes. A successful sign-in gets
// a session cookie holding the user id, the user's token version and an
// expiry, signed with AUTH_SECRET (HMAC-SHA256). Every request re-reads the
// user, so a deactivated account or a changed password (which bumps the token
// version) stops working at once, and role changes apply straight away.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Permission } from './permissions';

export const COOKIE = 'sp_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// --- password hashing -------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, N, r, p, salt, hash] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(got, want);
}

/** Checked against when the user does not exist, so a wrong ID takes as long as a wrong password. */
export const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export const PASSWORD_MIN = 6;

// --- session tokens ---------------------------------------------------------

export interface Session { uid: number; v: number }

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function makeToken(s: Session, secret: string, hours: number, now = Date.now()): string {
  const body = b64url(JSON.stringify({ uid: s.uid, v: s.v, exp: Math.floor(now / 1000) + Math.round(hours * 3600) }));
  return `${body}.${sign(body, secret)}`;
}

/** The session in a valid, unexpired token - otherwise null. */
export function readToken(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { uid, v, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number.isInteger(uid) && Number.isInteger(v) && typeof exp === 'number' && exp * 1000 > now ? { uid, v } : null;
  } catch {
    return null;
  }
}

export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// --- configuration ------------------------------------------------------------

export interface AuthConfig { secret: string; hours: number }

export function authConfig(): AuthConfig | null {
  const { AUTH_SECRET, SESSION_HOURS } = process.env;
  if (!AUTH_SECRET) return null;
  return { secret: AUTH_SECRET, hours: Number(SESSION_HOURS) || 24 * 7 };
}

/** Over HTTPS (the Cloudflare address) the cookie is marked Secure; on http://localhost it cannot be. */
function isHttps(req: Request): boolean {
  return /https/i.test(String(req.headers['x-forwarded-proto'] ?? '')) || /https/i.test(String(req.headers['cf-visitor'] ?? ''));
}

export function setSessionCookie(req: Request, res: Response, token: string, hours: number) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(req), maxAge: hours * 3600 * 1000,
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(req) });
}

// --- brute-force guard ----------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, { n: number; since: number }>();

/** The visitor's address: Cloudflare's header first, since everything arrives through the tunnel. */
export function clientIp(req: Request): string {
  return String(req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim()
    || req.socket.remoteAddress || 'unknown';
}

/** Minutes left on a lock-out, or 0 when this address may try again. */
export function lockedMinutes(ip: string, now = Date.now()): number {
  const f = failures.get(ip);
  if (!f || now - f.since > WINDOW_MS) return 0;
  return f.n >= MAX_FAILURES ? Math.ceil((f.since + WINDOW_MS - now) / 60000) : 0;
}

export function noteFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  if (!f || now - f.since > WINDOW_MS) failures.set(ip, { n: 1, since: now });
  else f.n++;
}

export function clearFailures(ip: string) {
  failures.delete(ip);
}

// --- the signed-in user on every request ------------------------------------------

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  tokenVersion: number;
  permissions: Set<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: SessionUser }
  }
}

/**
 * Refuses the request unless it carries a valid session for an active user
 * whose token version still matches; otherwise puts that user on req.user.
 */
export function requireSession(cfg: AuthConfig, loadUser: (id: number) => Promise<(SessionUser & { active: boolean }) | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = readToken(cookieValue(req, COOKIE), cfg.secret);
    const u = s ? await loadUser(s.uid) : null;
    if (!s || !u || !u.active || u.tokenVersion !== s.v) {
      res.status(401).json({ error: 'Please sign in' });
      return;
    }
    req.user = u;
    next();
  };
}

/** Lets the request through if the user holds ANY of the permissions given. */
export function need(...anyOf: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user && anyOf.some((p) => req.user!.permissions.has(p))) return next();
    res.status(403).json({ error: 'Your role does not allow this. Ask an administrator for access.' });
  };
}
