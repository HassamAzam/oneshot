/**
 * `/login` and `/logout`. Served before `authorise`, since a person without a
 * session has to reach the form.
 *
 * Failed attempts are counted per client address and the form refuses that
 * address for a while once it has had too many, so a password cannot be
 * guessed at the speed of the network. The count lives in memory: a restart
 * forgives everyone, which costs an attacker a restart they cannot cause.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLEAR_SESSION, sessionCookie } from './auth.js';
import { loginPage } from './page.js';
import { checkLogin, loadUsers } from './users.js';

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60_000;
const MAX_BODY = 4096;

const failures = new Map<string, { count: number; since: number }>();

export function lockedOut(addr: string, now = Date.now()): boolean {
  const f = failures.get(addr);
  if (!f) return false;
  if (now - f.since > LOCKOUT_MS) {
    failures.delete(addr);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

export function recordFailure(addr: string, now = Date.now()): void {
  const f = failures.get(addr);
  if (!f || now - f.since > LOCKOUT_MS) failures.set(addr, { count: 1, since: now });
  else f.count += 1;
}

export const forgetFailures = (addr: string): boolean => failures.delete(addr);

/** Only a path on this server, so the form cannot be used to bounce someone elsewhere. */
export const safeNext = (next: string | null): string =>
  next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !next.startsWith('/login') ? next : '/';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => done(body));
    req.on('error', fail);
  });
}

const html = (res: ServerResponse, code: number, body: string): void => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const redirect = (res: ServerResponse, location: string, cookie?: string): void => {
  res.writeHead(303, { location, ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
};

/** True when the request was a login or logout and has been answered. */
export async function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL, secret: string): Promise<boolean> {
  if (url.pathname === '/logout') {
    redirect(res, '/login', CLEAR_SESSION);
    return true;
  }
  if (url.pathname !== '/login') return false;

  const next = safeNext(url.searchParams.get('next'));
  if (req.method !== 'POST') {
    html(res, 200, loginPage(next));
    return true;
  }

  const addr = req.socket.remoteAddress ?? '';
  if (lockedOut(addr)) {
    html(res, 429, loginPage(next, 'Too many failed attempts. Try again in 15 minutes.'));
    return true;
  }
  const form = new URLSearchParams(await readBody(req));
  const username = (form.get('username') ?? '').trim().toLowerCase();
  const password = form.get('password') ?? '';
  const target = safeNext(form.get('next'));
  if (!checkLogin(username, password, loadUsers())) {
    recordFailure(addr);
    html(res, 401, loginPage(target, 'Wrong username or password.', username));
    return true;
  }
  forgetFailures(addr);
  redirect(res, target, sessionCookie(username, secret));
  return true;
}
