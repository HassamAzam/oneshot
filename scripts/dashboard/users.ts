/**
 * The dashboard's accounts: a JSON file of usernames and scrypt hashes.
 *
 * There is no signup. An operator adds people with `npm run dashboard-user`,
 * which is the only writer; the server only reads, and re-reads when the file
 * changes, so adding or removing someone needs no restart.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, envOr } from '../../src/lib/config.js';

export const USERS_FILE = envOr('ONESHOT_DASHBOARD_USERS', join(STATE, 'dashboard-users.json'));

export const USERNAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const MIN_PASSWORD = 10;

const KEY_LEN = 64;
const SALT_LEN = 16;

export interface User {
  hash: string;
  createdAt: number;
}
export type Users = Record<string, User>;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, KEY_LEN).toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(got, want);
}

let cache: { file: string; mtime: number; users: Users } | null = null;

/** Every account, or none when the file does not exist yet. */
export function loadUsers(file = USERS_FILE): Users {
  if (!existsSync(file)) return {};
  const mtime = statSync(file).mtimeMs;
  if (cache?.file === file && cache.mtime === mtime) return cache.users;
  const users = JSON.parse(readFileSync(file, 'utf8')) as Users;
  cache = { file, mtime, users };
  return users;
}

/** Written to a sibling and renamed, so the server never reads half a file. */
export function saveUsers(users: Users, file = USERS_FILE): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// A username that does not exist still pays for one scrypt, so a wrong name and
// a wrong password take the same time and the login form cannot list accounts.
const DECOY = hashPassword(randomBytes(SALT_LEN).toString('hex'));

export function checkLogin(username: string, password: string, users: Users): boolean {
  const user = Object.hasOwn(users, username) ? users[username] : undefined;
  const ok = verifyPassword(password, user?.hash ?? DECOY);
  return ok && user !== undefined;
}
