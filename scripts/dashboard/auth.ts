/**
 * Who may read the dashboard.
 *
 * On loopback nobody is asked: the machine's own user can already read state/.
 * Off loopback the pages carry run journals and transcripts, which quote
 * whatever a phase saw — so a non-loopback bind without a token is refused at
 * startup rather than served open. A person signs in at `/login` with an
 * account from users.ts and gets a session cookie signed with the token; a
 * script can still present the token itself as a Basic-auth password or once
 * as `?token=`, which sets a cookie.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Users } from './users.js';

const COOKIE = 'oneshot_dash';
const SESSION = 'oneshot_session';
export const SESSION_HOURS = 12;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export const isLoopback = (host: string): boolean => LOOPBACK.has(host) || host.startsWith('127.');

/** Throws when the bind would expose the pages without a token. */
export function requireTokenFor(host: string, token: string): void {
  if (!isLoopback(host) && !token) {
    throw new Error(`ONESHOT_DASHBOARD_HOST=${host} is not loopback; set ONESHOT_DASHBOARD_TOKEN or bind 127.0.0.1.`);
  }
}

// Hash both sides first so timingSafeEqual gets equal lengths and the token's
// length does not leak through an early return.
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
const matches = (given: string, token: string): boolean => timingSafeEqual(digest(given), digest(token));

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

const sign = (payload: string, secret: string): string => createHmac('sha256', secret).update(payload).digest('base64url');

/** `user.expiry.mac` — nothing stored on the server, so a restart signs nobody out. */
export function sessionCookie(user: string, secret: string, now = Date.now()): string {
  const payload = `${user}.${now + SESSION_HOURS * 3_600_000}`;
  return `${SESSION}=${encodeURIComponent(`${payload}.${sign(payload, secret)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

export const CLEAR_SESSION = `${SESSION}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

/** The signed-in user, or null. Removing someone from the users file signs them out on their next request. */
export function sessionUser(req: IncomingMessage, secret: string, users: Users, now = Date.now()): string | null {
  const raw = cookieValue(req, SESSION);
  if (!raw || !secret) return null;
  const cut = raw.lastIndexOf('.');
  const payload = raw.slice(0, cut);
  const [user, expiry] = payload.split('.');
  if (cut < 0 || !user || !matches(raw.slice(cut + 1), sign(payload, secret))) return null;
  if (!(Number(expiry) > now) || !Object.hasOwn(users, user)) return null;
  return user;
}

function presented(req: IncomingMessage, url: URL): { value: string; viaQuery: boolean } | null {
  const q = url.searchParams.get('token');
  if (q) return { value: q, viaQuery: true };
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return { value: decoded.slice(decoded.indexOf(':') + 1), viaQuery: false };
  }
  const cookie = cookieValue(req, COOKIE);
  return cookie === null ? null : { value: cookie, viaQuery: false };
}

const wantsPage = (req: IncomingMessage, url: URL): boolean =>
  !url.pathname.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');

/**
 * True when the request may proceed. Otherwise the response has been written:
 * a browser is sent to `/login`, anything else gets a 401 challenge, and a
 * correct `?token=` gets a cookie and a redirect to the same URL without the
 * token, so it does not sit in history or a referrer.
 */
export function authorise(req: IncomingMessage, res: ServerResponse, url: URL, token: string, users: Users): boolean {
  if (!token) return true;
  if (sessionUser(req, token, users)) return true;
  const got = presented(req, url);
  if (got && matches(got.value, token)) {
    if (!got.viaQuery) return true;
    url.searchParams.delete('token');
    res.writeHead(303, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  if (wantsPage(req, url)) {
    res.writeHead(303, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
    res.end();
    return false;
  }
  res.writeHead(401, { 'www-authenticate': 'Basic realm="oneshot"', 'content-type': 'text/plain' });
  res.end('Unauthorised');
  return false;
}
