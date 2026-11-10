import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { SESSION_HOURS, sessionCookie, sessionUser } from './auth.js';
import { LOCKOUT_MS, MAX_FAILURES, lockedOut, recordFailure, safeNext } from './login.js';
import { checkLogin, hashPassword, verifyPassword, type Users } from './users.js';

const SECRET = 'a-dashboard-token';
const users: Users = { hassam: { hash: hashPassword('correct horse battery'), createdAt: 0 } };
const asRequest = (setCookie: string): IncomingMessage =>
  ({ headers: { cookie: setCookie.split(';')[0] } }) as IncomingMessage;

test('a stored hash verifies only its own password', () => {
  const hash = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', hash), true);
  assert.equal(verifyPassword('correct horse batterz', hash), false);
  assert.notEqual(hash, hashPassword('correct horse battery'));
});

test('login refuses an unknown user and a wrong password alike', () => {
  assert.equal(checkLogin('hassam', 'correct horse battery', users), true);
  assert.equal(checkLogin('hassam', 'wrong password!', users), false);
  assert.equal(checkLogin('nobody', 'correct horse battery', users), false);
  assert.equal(checkLogin('__proto__', 'correct horse battery', users), false);
});

test('a session cookie names its user until it expires', () => {
  const now = 1_000_000;
  const req = asRequest(sessionCookie('hassam', SECRET, now));
  assert.equal(sessionUser(req, SECRET, users, now + 1000), 'hassam');
  assert.equal(sessionUser(req, SECRET, users, now + SESSION_HOURS * 3_600_000 + 1), null);
});

test('a session is refused when forged, signed with another secret, or its user was removed', () => {
  const now = 1_000_000;
  const good = sessionCookie('hassam', SECRET, now);
  assert.equal(sessionUser(asRequest(good), 'another-token', users, now), null);
  assert.equal(sessionUser(asRequest(good.replace('hassam', 'mallory')), SECRET, { ...users, mallory: users.hassam! }, now), null);
  assert.equal(sessionUser(asRequest(good), SECRET, {}, now), null);
  assert.equal(sessionUser(asRequest('oneshot_session=garbage'), SECRET, users, now), null);
});

test('an address is locked out after too many failures, and forgiven once the window passes', () => {
  const addr = '10.0.0.9';
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) recordFailure(addr, 0);
  assert.equal(lockedOut(addr, 1), false);
  recordFailure(addr, 0);
  assert.equal(lockedOut(addr, 1), true);
  assert.equal(lockedOut(addr, LOCKOUT_MS + 1), false);
});

test('after login only a path on this server is followed', () => {
  assert.equal(safeNext('/run/42?archived=x'), '/run/42?archived=x');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/login?next=/'), '/');
  assert.equal(safeNext(null), '/');
});
