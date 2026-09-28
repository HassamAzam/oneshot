/**
 * Compare this machine's .env against the template it was copied from.
 *
 * Every .env on the team started as a copy of .env.example and then stopped
 * tracking it. The drift is invisible and the symptoms are not: a missing
 * ONESHOT_SEED_LINKS entry surfaces three phases later as a dead Django
 * server, and a setting that was REMOVED from the template goes on sitting in
 * the file looking authoritative — ONESHOT_GITLAB_USERNAME is read by no code
 * at all, and a leftover ONESHOT_PROJECT that disagrees with GITLAB_REPO_URL
 * refuses boot. The judgement lives in src/lib/envdrift.ts.
 *
 * Reports three kinds of drift and prescribes nothing else: the template is
 * the spec, and a line-by-line answer is what makes the fix the same on every
 * machine instead of a conversation per person.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/config.js';
import { envDrift, driftCount } from '../src/lib/envdrift.js';

const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[31m';
const D = '\x1b[2m'; const X = '\x1b[0m';

const envPath = join(ROOT, '.env');
const tmplPath = join(ROOT, '.env.example');
if (!existsSync(envPath)) {
  console.error(`${R}no .env at ${envPath}${X}  —  cp .env.example .env && chmod 600 .env`);
  process.exit(1);
}

const drift = envDrift(readFileSync(envPath, 'utf8'), readFileSync(tmplPath, 'utf8'));
const { missing, stale, placeholders, unknown } = drift;
const problems = driftCount(drift);
const section = (t: string): void => console.log(`\n${t}`);

section('Settings this machine has not got yet');
if (missing.length) {
  for (const { key, suggested } of missing) {
    console.log(`  ${Y}MISSING${X}  ${key}=${suggested}${suggested ? '' : `${D}  (blank in the template)${X}`}`);
  }
} else console.log(`  ${G}none${X}  — every template key is present`);

section('Settings the template has retired');
if (stale.length) {
  for (const k of stale) console.log(`  ${R}STALE${X}    ${k}  — retired; delete the line and its comment`);
} else console.log(`  ${G}none${X}`);

section('Values still holding a placeholder');
if (placeholders.length) {
  for (const { key, value } of placeholders) console.log(`  ${R}UNFILLED${X} ${key}=${value}`);
} else console.log(`  ${G}none${X}`);

if (unknown.length) {
  section('Not in the template (may be fine — local additions)');
  for (const k of unknown) console.log(`  ${D}extra${X}    ${k}`);
}

console.log(problems === 0
  ? `\n${G}.env matches the template.${X}`
  : `\n${problems} difference(s) from ${D}.env.example${X}. Fix them, then \`npm run doctor\`.`);
process.exit(problems === 0 ? 0 : 1);
