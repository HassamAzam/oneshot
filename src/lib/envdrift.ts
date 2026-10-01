/**
 * How a machine's .env has drifted from the template it was copied from.
 *
 * Every .env on the team started as a copy of .env.example and then stopped
 * tracking it. The drift is invisible and the symptoms are not: a missing
 * ONESHOT_SEED_LINKS entry surfaces three phases later as a dead Django server,
 * and a setting the template RETIRED goes on sitting in the file looking
 * authoritative. Kept apart from scripts/envcheck.ts, which reads files and
 * prints, so the judgement can be tested.
 *
 * Both files are read with dotenv.parse — the parser the conductor loads .env
 * with — so an `export ` prefix or an inline `# comment` means here exactly
 * what it means at boot.
 */
import { parse } from 'dotenv';
import { LEGACY_SELECTOR_KEYS, isPlaceholder, spellings } from './repourl.cjs';

/**
 * Keys the template has retired, in both spellings. The legacy selectors come
 * from repourl.cjs rather than from the template's prose, so a rewording of
 * .env.example cannot hide one — a disagreeing ONESHOT_PROJECT refuses boot.
 */
export const RETIRED_KEYS: ReadonlySet<string> = new Set([
  ...LEGACY_SELECTOR_KEYS,
  ...spellings('ONESHOT_GITLAB_USERNAME'),
]);

/** The per-project path names, which are generated rather than listed in the template. */
const SCOPED_PATH = /^ONE(SHOT|LOOP)_[A-Z0-9_]+_(WORK_REPO|SEED_FROM|WT_ROOT)$/;

/** `ONELOOP_X` answers for `ONESHOT_X`, as it does everywhere the conductor reads one. */
const canonical = (k: string): string => (k.startsWith('ONELOOP_') ? `ONESHOT_${k.slice('ONELOOP_'.length)}` : k);

export interface EnvDrift {
  /** Template keys this .env has not got, with the template's value. */
  missing: Array<{ key: string; suggested: string }>;
  /** Keys the template has retired that this .env still sets. */
  stale: string[];
  /** Keys whose value is still a placeholder. */
  placeholders: Array<{ key: string; value: string }>;
  /** Keys the template never had — reported, but not counted as a difference. */
  unknown: string[];
}

export function envDrift(envText: string, templateText: string): EnvDrift {
  const mine = parse(envText);
  const tmpl = parse(templateText);
  const have = new Set(Object.keys(mine).map(canonical));

  const missing = Object.keys(tmpl)
    .filter((k) => !have.has(k))
    .map((key) => ({ key, suggested: tmpl[key] ?? '' }));
  const stale = Object.keys(mine).filter((k) => RETIRED_KEYS.has(k));
  const placeholders = Object.entries(mine)
    .filter(([, v]) => v !== '' && isPlaceholder(v))
    .map(([key, value]) => ({ key, value }));
  const unknown = Object.keys(mine)
    .filter((k) => !(canonical(k) in tmpl) && !RETIRED_KEYS.has(k) && !SCOPED_PATH.test(k));
  return { missing, stale, placeholders, unknown };
}

/** The number of differences that make `npm run env:check` exit non-zero. */
export function driftCount(d: EnvDrift): number {
  return d.missing.length + d.stale.length + d.placeholders.length;
}
