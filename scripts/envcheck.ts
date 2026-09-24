/**
 * Compare this machine's .env against the template it was copied from.
 *
 * Every .env on the team started as a copy of .env.example and then stopped
 * tracking it. The drift is invisible and the symptoms are not: a missing
 * ONESHOT_SEED_LINKS entry surfaces three phases later as a dead Django
 * server, and a setting that was REMOVED from the template goes on sitting in
 * the file looking authoritative — ONESHOT_GITLAB_USERNAME is read by no code
 * at all, but its comment still promises to scope ticket selection.
 *
 * Reports three kinds of drift and prescribes nothing else: the template is
 * the spec, and a line-by-line answer is what makes the fix the same on every
 * machine instead of a conversation per person.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isPlaceholder } from '../src/lib/config.js';

const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[31m';
const D = '\x1b[2m'; const X = '\x1b[0m';

/** key -> value, ignoring comments and blanks. Later wins, as dotenv does. */
function parse(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** Keys the template mentions in prose as deliberately gone. */
function retiredInTemplate(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/([A-Z][A-Z0-9_]{3,})\s+was removed/g)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

const envPath = join(ROOT, '.env');
const tmplPath = join(ROOT, '.env.example');
if (!existsSync(envPath)) {
  console.error(`${R}no .env at ${envPath}${X}  —  cp .env.example .env && chmod 600 .env`);
  process.exit(1);
}

const tmplText = readFileSync(tmplPath, 'utf8');
const mine = parse(readFileSync(envPath, 'utf8'));
const tmpl = parse(tmplText);
const retired = retiredInTemplate(tmplText);

const missing = [...tmpl.keys()].filter((k) => !mine.has(k));
const extra = [...mine.keys()].filter((k) => !tmpl.has(k));
const stale = extra.filter((k) => retired.has(k));
// A variable the template never had is not automatically wrong: the scoped
// ONESHOT_<TARGET>_<VAR> names are generated, not listed.
const unknown = extra.filter((k) => !retired.has(k) && !/^ONESHOT_[A-Z0-9]+_/.test(k));
const placeholders = [...mine.entries()].filter(([, v]) => v && isPlaceholder(v)).map(([k]) => k);

let problems = 0;
const section = (t: string): void => console.log(`\n${t}`);

section('Settings this machine has not got yet');
if (missing.length) {
  problems += missing.length;
  for (const k of missing) {
    const suggested = tmpl.get(k) ?? '';
    console.log(`  ${Y}MISSING${X}  ${k}=${suggested}${suggested ? '' : `${D}  (blank in the template)${X}`}`);
  }
} else console.log(`  ${G}none${X}  — every template key is present`);

section('Settings the template has retired');
if (stale.length) {
  problems += stale.length;
  for (const k of stale) console.log(`  ${R}STALE${X}    ${k}  — read by no code; delete the line and its comment`);
} else console.log(`  ${G}none${X}`);

section('Values still holding a placeholder');
if (placeholders.length) {
  problems += placeholders.length;
  for (const k of placeholders) console.log(`  ${R}UNFILLED${X} ${k}=${mine.get(k)}`);
} else console.log(`  ${G}none${X}`);

if (unknown.length) {
  section('Not in the template (may be fine — local additions)');
  for (const k of unknown) console.log(`  ${D}extra${X}    ${k}`);
}

console.log(problems === 0
  ? `\n${G}.env matches the template.${X}`
  : `\n${problems} difference(s) from ${D}.env.example${X}. Fix them, then \`npm run doctor\`.`);
process.exit(problems === 0 ? 0 : 1);
