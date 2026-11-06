/**
 * Who may read the dashboard.
 *
 * On loopback nobody is asked: the machine's own user can already read state/.
 * Off loopback the pages carry run journals and transcripts, which quote
 * whatever a phase saw — so a non-loopback bind without a token is refused at
 * startup rather than served open, and every request must present the token as
 * a Basic-auth password or a cookie set once by `?token=`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE = 'oneshot_dash';
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

function presented(req: IncomingMessage, url: URL): { value: string; viaQuery: boolean } | null {
  const q = url.searchParams.get('token');
  if (q) return { value: q, viaQuery: true };
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return { value: decoded.slice(decoded.indexOf(':') + 1), viaQuery: false };
  }
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return cookie ? { value: decodeURIComponent(cookie.slice(COOKIE.length + 1)), viaQuery: false } : null;
}

/**
 * True when the request may proceed. Otherwise the response has been written:
 * a 401 challenge, or — for a correct `?token=` — a cookie and a redirect to the
 * same URL without the token, so it does not sit in history or a referrer.
 */
export function authorise(req: IncomingMessage, res: ServerResponse, url: URL, token: string): boolean {
  if (!token) return true;
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
  res.writeHead(401, { 'www-authenticate': 'Basic realm="oneshot"', 'content-type': 'text/plain' });
  res.end('Unauthorised');
  return false;
}
