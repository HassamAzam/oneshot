/**
 * Line edits on the text of a .env file, for `npm run setup`.
 *
 * Kept out of scripts/setup.ts, which prompts on import, so the one part of the
 * wizard that decides what ends up in .env can be tested. The rule that makes
 * these more than string helpers: a reconfigure starts from the EXISTING .env,
 * and a plain or scoped path line left in it beats whatever the wizard derives,
 * so an answer that equals the derived default has to REMOVE the old line, not
 * just skip writing a new one.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { LEGACY_SELECTOR_KEYS, expandPath, scopedEnvName, spellings } from './repourl.cjs';

const lineRe = (key: string): RegExp => new RegExp(`^${key}=.*$`, 'm');

/**
 * Replace `key`'s uncommented line, or append one. An empty value writes nothing.
 *
 * The line goes in through a FUNCTION replacer: as a replacement STRING, a
 * token containing `$&`, `$'`, `` $` `` or `$1` would splice pieces of the
 * old .env into the new one and truncate the token itself.
 */
export function setKey(body: string, key: string, value: string): string {
  if (!value) return body;
  const re = lineRe(key);
  const line = `${key}=${value}`;
  return re.test(body) ? body.replace(re, () => line) : `${body}\n${line}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Copy `file` to `<file>.bak-YYYYMMDD-HHMMSS` (local time) at mode 600 — it
 * holds the same secrets — and return the copy's path. A second backup in the
 * same second gets a `-2`, `-3` suffix rather than overwriting the first.
 */
export function backupFile(file: string, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const content = readFileSync(file);
  for (let n = 1; ; n += 1) {
    const dest = `${file}.bak-${stamp}${n > 1 ? `-${n}` : ''}`;
    try {
      writeFileSync(dest, content, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    chmodSync(dest, 0o600);
    return dest;
  }
}

/** Every uncommented `key=` line removed. Commented lines are documentation and stay. */
export function removeKey(body: string, key: string): string {
  return body.replace(new RegExp(`^${key}=.*(?:\\n|$)`, 'gm'), '');
}

/** The value on `key`'s uncommented line, or null when there is none. */
export function readKey(body: string, key: string): string | null {
  const m = lineRe(key).exec(body);
  return m ? m[0].slice(key.length + 1).trim() : null;
}

/** Both spellings of the scoped `ONESHOT_<NAME>_<VAR>` a path variable also answers to. */
function scopedKeys(name: string, envName: string): string[] {
  const k = scopedEnvName(name, envName);
  return k ? spellings(k) : [];
}

/**
 * Make `answer` the path `envName` resolves to for project `name`.
 *
 * Any scoped line goes, because it would outrank the answer. The plain line is
 * written only when the answer differs from `derived`; otherwise it is removed,
 * so that pointing GITLAB_REPO_URL at another project later moves the path with
 * it instead of leaving a pinned line from this one behind to disagree.
 */
export function pinPath(body: string, o: {
  envName: string; name: string; answer: string; derived: string; root: string;
}): string {
  let out = body;
  for (const k of scopedKeys(o.name, o.envName)) out = removeKey(out, k);
  if (o.derived && expandPath(o.answer, o.root) === expandPath(o.derived, o.root)) return removeKey(out, o.envName);
  return setKey(out, o.envName, o.answer);
}

/** The legacy selector lines still set in `body`, as `KEY=value`. */
export function legacyLines(body: string): string[] {
  return LEGACY_SELECTOR_KEYS
    .map((k) => [k, readKey(body, k)] as const)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

/** `body` without any legacy selector line. */
export function removeLegacySelectors(body: string): string {
  return LEGACY_SELECTOR_KEYS.reduce((b, k) => removeKey(b, k), body);
}
