#!/usr/bin/env node
/**
 * Which workstream-automation specs a ticket's diff reaches, and what running them costs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The local-tests-scope session decides which Cypress specs run against a ticket's code
 * before the MR. Its judgement is wanted on exactly two things: which of the candidates
 * are worth the wall clock, and what temporary spec edit an INTENDED UI change needs.
 * Everything else - what the diff touched, which testids it added or dropped, which page
 * objects select them, how many it() blocks a spec holds, how long CI took on it - is
 * arithmetic over two repositories, and a session that does it by grep gets a different
 * answer every time. So it is done here, once, deterministically, and the session is told
 * to treat these numbers as authoritative.
 *
 * READ-ONLY ON BOTH REPOS
 * -----------------------
 * The ERP side is read through `git diff`, `git ls-tree` and `git cat-file` at refs, never
 * through the working tree: the head is usually a ticket branch nobody has checked out,
 * and a checkout would move a tree other runs are using. The automation side is read from
 * the directory it is pointed at - in a run that is the throwaway worktree at
 * state/runs/<iid>/wsa, so a re-run after the session's temporary edits sees them.
 * cypress.env.json is never opened.
 *
 * WHAT COUNTS AS REACHED
 * ----------------------
 *   - every spec in a cypress/e2e module that modules-map.json maps a changed folder to;
 *   - every spec whose DIRECT imports include a page object selecting a testid the diff
 *     added, removed, renamed or referenced. Direct only: nearly every spec reaches
 *     Pages/sidePanel/side_panel.ts transitively, so transitive matching selects the suite.
 *     A generic testid - selected by page objects in GENERIC_FOLDERS or more Pages
 *     folders, or defined by the testIds files of two or more ERP folders - only matches
 *     inside the Pages folders of the area that referenced it; see the map's own `_why`.
 *
 * THE MAIN FUNCTIONALITY OF A MODULE
 * ----------------------------------
 * `mainSpecs` is what runs for every module the change maps to, whether or not a spec
 * reaches the change itself: the module's own `smoke`-tagged specs (the team's mark, in
 * `TestFilters(['regression', 'smoke'], …)`), lowest case number first, at most
 * MAIN_SPECS_PER_MODULE of them. A module that tags none gives its first cases instead,
 * which open its screens. Picked here and not by the session, so one module always gives
 * the same tests.
 *
 * THE SCREENS THE CHANGE TOUCHED
 * ------------------------------
 * Most fixes change logic, not testids, so the testid match above often reaches nothing
 * while a spec does open the screen the fix changed. `screenSpecs` lists those: specs whose
 * directly imported page objects select a testid that a changed component renders ANYWHERE
 * in the file, not only on its changed lines. That is a candidate list, not a choice: a
 * popup's page object is imported by many specs, and which of them go through the changed
 * behaviour is the session's to judge (it takes at most a few). A generic testid counts
 * only inside the changed area's own Pages folders, and never for a shared component.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* ------------------------------------------------------------------ errors */

/** A closed set, as in harness.cjs: a session that gets a code reports it, it does not improvise. */
const CODES = ['E_ARGS', 'E_GIT', 'E_REF_UNRESOLVED', 'E_NO_AUTOMATION', 'E_NO_MAP'];

class ImpactError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = CODES.includes(code) ? code : 'E_GIT';
    this.hint = hint || null;
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

/* ------------------------------------------------------------------ constants */

/**
 * Page objects in this many Pages folders select it: `submit-button`, not
 * `evidence-notice-banner`. Two ERP folders defining a value makes it generic as well.
 */
const GENERIC_FOLDERS = 3;
/** How many main-functionality specs each impacted module adds to the list (`mainSpecs`). */
const MAIN_SPECS_PER_MODULE = 5;
/** How many `screenSpecs` candidates are listed: impacted modules first, then the most testids matched. */
const MAX_SCREEN_SPECS = 25;
/** estimatedMinutes = ceil((sum ciSeconds * CI_FACTOR + specs * SPEC_OVERHEAD_S) / 60). */
const CI_FACTOR = 1.15;
const SPEC_OVERHEAD_S = 8;

const TESTIDS_FILE = /(^|\/)[^/]*[tT]est[iI]ds\.js$/;
const CODE_FILE = /\.(jsx?|tsx?)$/;
const COMPONENTS = 'frontend/src/components/';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const uniq = (xs) => [...new Set(xs)].sort();

function loadMap(file) {
  const map = readJson(file || path.join(__dirname, 'modules-map.json'));
  if (!map || !map.frontend || !map.backend) {
    throw new ImpactError('E_NO_MAP', `modules map unreadable: ${file || 'modules-map.json'}`);
  }
  map.ignoreRes = (map.ignore || []).map((re) => new RegExp(re));
  return map;
}

/* ------------------------------------------------------------------ git (read-only) */

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new ImpactError('E_GIT', `git ${args.join(' ')}: ${(r.stderr || '').trim().slice(0, 300)}`);
  }
  return r.stdout;
}

function revParse(repo, ref) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new ImpactError('E_REF_UNRESOLVED', `${ref} does not resolve in ${repo}`, 'Fetch the ref first, or pass a sha.');
  }
  return r.stdout.trim();
}

/**
 * Many `<ref>:<path>` blobs through one `git cat-file --batch`. A missing blob is null.
 * Sizes are bytes, so the slicing is done on the Buffer: a file with one non-ASCII
 * character would shift every later blob by a byte if it were done on a string.
 */
function showMany(repo, items) {
  const out = new Map();
  if (!items.length) return out;
  const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: `${items.join('\n')}\n`, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new ImpactError('E_GIT', `git cat-file --batch: ${String(r.stderr).trim().slice(0, 300)}`);
  const buf = r.stdout;
  let at = 0;
  for (const item of items) {
    const nl = buf.indexOf(10, at);
    const header = buf.toString('utf8', at, nl);
    at = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) { out.set(item, null); continue; }
    const size = Number(header.split(' ')[2]);
    out.set(item, buf.toString('utf8', at, at + size));
    at += size + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ source parsing */

/** Words after which a `/` opens a regex literal rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Does a `/` after `out` open a regex literal? Where a value is expected - at the start,
 * after an operator, an opening bracket or a word like `return` - it does; after a name,
 * a number, a string or a closing `)`/`]` it divides.
 */
function regexStarts(out) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k -= 1;
  if (k < 0) return true;
  if (!/[\w$]/.test(out[k])) return !/[)\]'"`]/.test(out[k]);
  let w = k;
  while (w > 0 && /[\w$]/.test(out[w - 1])) w -= 1;
  return REGEX_AFTER_WORD.has(out.slice(w, k + 1));
}

/**
 * Source with comments blanked, strings kept - or emptied too, with `blankStrings`. A
 * commented-out `it(` is not a test case and a commented-out import is not a dependency;
 * a `//` inside a URL string is neither, and neither is an `it(` inside a title. A regex
 * literal is skipped whole, so the quote in `/['"]/` opens no string that would blank
 * the rest of the file.
 */
function stripComments(src, blankStrings = false) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; }
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      out += blankStrings ? c + c : src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && regexStarts(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j += 1;
      }
      out += blankStrings ? '/ /' : src.slice(i, j + 1);
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/** `it(`, `it (`, `it.only(`, `it.skip(` and `it.each(`: each one is a case Cypress reports. */
const countIts = (src) => (stripComments(src, true).match(/\bit(?:\.(?:only|skip|each))?\s*\(/g) || []).length;

/**
 * The tags a spec is filtered by: the list in `TestFilters(['regression', 'smoke'], () => …)`,
 * the repo's own way of saying which runs a spec belongs to. `smoke` marks a module's main
 * functionality. Comments are stripped first, so a commented-out wrapper tags nothing.
 */
function specTags(src) {
  const m = stripComments(src).match(/\bTestFilters\s*\(\s*\[([^\]]*)\]/);
  if (!m) return [];
  return uniq([...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1].trim()).filter(Boolean));
}

/** The case number a spec's file name carries, part by part (`LV_04.1_…` [4, 1], `trainings_01_…` [1]); null without one. */
function caseNumber(file) {
  const m = path.basename(file).match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : null;
}

/**
 * Lowest case number first, compared part by part, then by name: `LV_06` before
 * `LV_06.1` before `LV_13`, `PRL_02` before `PRL_10`, and `TR_74.2` before
 * `TR_74.13` (sub-cases are counted, not decimals). A file with no number goes last.
 */
function byCase(a, b) {
  const x = caseNumber(a);
  const y = caseNumber(b);
  if (!x || !y) return (x ? -1 : y ? 1 : 0) || a.localeCompare(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

/**
 * The main-functionality specs of each module in `modules`: its `smoke`-tagged specs,
 * else its first cases, at most MAIN_SPECS_PER_MODULE, in case order. `basis` says which.
 */
function mainSpecsOf(modules, specFiles, tagsOf) {
  const out = [];
  for (const mod of modules) {
    const own = specFiles.filter((f) => f.split('/')[2] === mod).sort(byCase);
    const smoke = own.filter((f) => (tagsOf.get(f) || []).includes('smoke'));
    const basis = smoke.length ? 'smoke' : 'first';
    for (const file of (smoke.length ? smoke : own).slice(0, MAIN_SPECS_PER_MODULE)) out.push({ file, module: mod, basis });
  }
  return out;
}

/**
 * Calls an API helper (`ExpenseApi.clearAllExpenses(`), an e2e endpoint, or a raw
 * delete/clear request: the spec writes to the database it runs on. Reported, not
 * filtered - every run gets its own copy of the DB - so the session can order or trim.
 */
function isDestructive(src) {
  const s = stripComments(src);
  return /\b\w*[aA]pi\.\w+\s*\(/.test(s) || /\/e2e\//.test(s) || /cy\.request\([^;]*?(DELETE|delete|clear)/.test(s);
}

/**
 * `export const fooTestIds = { key: 'value', ... }` -> { fooTestIds: { key: 'value' } }.
 *
 * A per-row testid is a function (`suggestionRow: id => \`cv-verify-suggestion-row-${id}\``);
 * it is kept as its prefix plus `*`, the same form selectorTestids() gives a page object's
 * `^=` or `${...}` selector, so the two meet on one string without a pattern matcher.
 */
function parseTestIds(src) {
  const exportsOf = {};
  let cur = null;
  for (const line of String(src || '').split(/\r?\n/)) {
    const open = line.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/);
    if (open) { cur = open[1]; exportsOf[cur] = {}; continue; }
    if (!cur) continue;
    if (/^\s*\};?\s*$/.test(line)) { cur = null; continue; }
    const kv = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(['"`])([^'"`$]*)\2/);
    const fn = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*`([^`$]+)\$\{/);
    if (kv) exportsOf[cur][kv[1]] = kv[3];
    else if (fn) exportsOf[cur][fn[1]] = `${fn[2]}*`;
  }
  return exportsOf;
}

/** Every testid a page object selects: exact values, and `prefix*` for `^=` and `${...}` selectors. */
function selectorTestids(src) {
  const out = new Set();
  for (const m of src.matchAll(/data-testid([*$~|]?)=\s*\\?(["']?)([A-Za-z0-9_\-:.]+)\2/g)) out.add(m[3]);
  for (const m of src.matchAll(/data-testid\^=\s*\\?(["']?)([A-Za-z0-9_\-:.]+)\1/g)) out.add(`${m[2]}*`);
  for (const m of src.matchAll(/data-testid=\s*\\?(["'])([A-Za-z0-9_\-:.]+)\$\{/g)) out.add(`${m[2]}*`);
  return out;
}

/* ------------------------------------------------------------------ ERP side */

function changedFiles(erp, mergeBase, head) {
  const all = [];
  const parts = git(erp, ['diff', '--name-status', '-z', '-M', mergeBase, head]).split('\0');
  for (let i = 0; i < parts.length - 1;) {
    const st = parts[i++];
    if (st[0] === 'R' || st[0] === 'C') all.push({ status: st[0], from: parts[i++], path: parts[i++] });
    else all.push({ status: st[0], path: parts[i++] });
  }
  all.sort((x, y) => x.path.localeCompare(y.path));
  const paths = all.map((f) => f.path);
  return {
    all,
    frontend: paths.filter((p) => p.startsWith('frontend/')),
    migrations: paths.filter((p) => /^apps\/[^/]+\/migrations\//.test(p)),
    backend: paths.filter((p) => !/^apps\/[^/]+\/migrations\//.test(p) && (p.startsWith('apps/') || p.endsWith('.py'))),
    other: paths.filter((p) => !p.startsWith('frontend/') && !p.startsWith('apps/') && !p.endsWith('.py')),
  };
}

/**
 * Where a changed file lives, in the map's terms. `kind` is one of mapped, shared,
 * uncovered, ignored, other, or unmapped - a folder the map has never heard of, which
 * is reported as a warning because it means the map has drifted from the repo.
 */
function areaOf(map, file) {
  if (map.ignoreRes.some((re) => re.test(file))) return { area: 'ignored', kind: 'ignored' };
  const pick = (side, rest) => {
    const keys = Object.keys(map[side]).filter((k) => rest === k || rest.startsWith(`${k}/`));
    const key = keys.sort((a, b) => b.length - a.length)[0];
    if (key) return { area: `${side}:${key}`, kind: 'mapped', e2e: map[side][key].e2e, pages: map[side][key].pages };
    const top = rest.split('/')[0];
    if (!rest.includes('/') || (map.shared[side] || []).includes(top)) return { area: `${side}:${top}`, kind: 'shared' };
    if ((map.uncovered[side] || []).includes(top)) return { area: `${side}:${top}`, kind: 'uncovered' };
    return { area: `${side}:${top}`, kind: 'unmapped' };
  };
  if (file.startsWith(COMPONENTS)) return pick('frontend', file.slice(COMPONENTS.length));
  if (file.startsWith('frontend/')) {
    return { area: `frontend:${file.replace(/^frontend\/(src\/)?/, '').split('/')[0]}`, kind: 'shared' };
  }
  if (file.startsWith('apps/')) return pick('backend', file.slice('apps/'.length));
  return { area: 'other', kind: 'other' };
}

/** Every testIds file at a ref, parsed: { path: { exportName: { key: value } } }. */
function testIdsAt(erp, ref) {
  const files = git(erp, ['ls-tree', '-r', '--name-only', ref, '--', 'frontend/src'])
    .split('\n').filter((p) => TESTIDS_FILE.test(p));
  const blobs = showMany(erp, files.map((f) => `${ref}:${f}`));
  const out = {};
  for (const f of files) out[f] = parseTestIds(blobs.get(`${ref}:${f}`));
  return out;
}

/**
 * Local name -> testIds object, for one component file at one ref. Imports are resolved
 * by path first, because two files both export a bare `testIds` (home and home_page);
 * a name imported through a barrel falls back to the one testIds export of that name.
 */
function resolverFor(file, src, ids) {
  const byName = {};
  for (const exp of Object.values(ids)) for (const [name, obj] of Object.entries(exp)) (byName[name] = byName[name] || []).push(obj);
  const local = {};
  for (const [name, objs] of Object.entries(byName)) if (objs.length === 1) local[name] = objs[0];
  for (const m of String(src || '').matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!m[2].startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
    const target = [base, `${base}.js`, `${base}/index.js`].find((c) => ids[c]);
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (!orig) continue;
      if (target && ids[target][orig]) local[alias || orig] = ids[target][orig];
      else if (alias && local[orig]) local[alias] = local[orig];
    }
  }
  return local;
}

/** The testid values one piece of component source references, and the references it could not resolve. */
function referencesIn(text, local) {
  const values = new Set();
  const unresolved = new Set();
  for (const m of text.matchAll(/data-testid=\{?\s*(["'`])([^"'`$]+)\1/g)) values.add(m[2]);
  for (const m of text.matchAll(/data-testid=\{\s*`([^`$]+)\$\{/g)) values.add(`${m[1]}*`);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g)) {
    if (local[m[1]]) {
      if (local[m[1]][m[2]] !== undefined) values.add(local[m[1]][m[2]]);
      else unresolved.add(`${m[1]}.${m[2]}`);
    } else if (/[tT]est[iI]ds$/.test(m[1])) {
      unresolved.add(`${m[1]}.${m[2]}`);
    }
  }
  return { values, unresolved };
}

/**
 * `git diff -U0` of frontend/ split into per-file added and removed lines, for the files
 * asked about. One pathspec rather than one argument per file: a promotion branch
 * touches thousands of files, and that many arguments is past the OS's argv limit.
 */
function diffLines(erp, mergeBase, head, paths) {
  const out = {};
  if (!paths.length) return out;
  const wanted = new Set(paths);
  let cur = null;
  let inHunk = false;
  for (const line of git(erp, ['diff', '-U0', '--no-color', '-M', mergeBase, head, '--', 'frontend/']).split('\n')) {
    const hdr = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (hdr) { cur = wanted.has(hdr[2]) ? { plus: [], minus: [] } : null; if (cur) out[hdr[2]] = cur; inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!cur || !inHunk) continue;
    if (line.startsWith('+')) cur.plus.push(line.slice(1));
    else if (line.startsWith('-')) cur.minus.push(line.slice(1));
  }
  return out;
}

/* ------------------------------------------------------------------ automation side */

function walk(root, rel, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) walk(root, r, filter, out);
    else if (filter(r)) out.push(r);
  }
  return out;
}

/** Every file a selector can live in, with the testids it selects. Paths relative to the automation root. */
function selectorIndex(wsa) {
  const index = new Map();
  for (const dir of ['cypress/Pages', 'cypress/utils', 'cypress/fixtures']) {
    for (const f of walk(wsa, dir, (r) => /\.[jt]s$/.test(r))) index.set(f, selectorTestids(fs.readFileSync(path.join(wsa, f), 'utf8')));
  }
  return index;
}

/** `Pages/teamReview` for a page object, `utils` for cypress/utils/filter.ts. */
const folderOf = (f) => {
  const parts = f.replace(/^cypress\//, '').split('/');
  return parts[0] === 'Pages' ? `Pages/${parts[1]}` : parts[0];
};

/** A spec's direct imports that resolve to a file in the selector index. */
function directImports(wsa, spec, src, index) {
  const out = new Set();
  for (const m of stripComments(src).matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"]([^'"]+)['"]/g)) {
    let base;
    if (m[1].startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(spec), m[1]));
    else if (m[1].startsWith('cypress/')) base = m[1];
    else continue;
    const hit = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`].find((c) => index.has(c));
    if (hit) out.add(hit);
  }
  return out;
}

/* ------------------------------------------------------------------ analysis */

/**
 * it() count, CI seconds and the run-time estimate for a list of specs. One function for
 * both the candidate list and the session's final one (`index.cjs estimate`), so the
 * minutes a QA reviewer reads were computed the same way whichever list they describe.
 * A spec CI has no timing for - a new temporary one, usually - costs the median.
 */
function costOf(automation, files) {
  const timings = readJson(path.join(automation, 'cypress', 'spec-timings.json'), {}) || {};
  const known = Object.values(timings).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 30;
  const specs = files.map((file) => {
    const src = fs.readFileSync(path.join(automation, file), 'utf8');
    return { file, its: countIts(src), ciSeconds: typeof timings[file] === 'number' ? timings[file] : null, destructive: isDestructive(src) };
  });
  const seconds = specs.reduce((sum, x) => sum + (x.ciSeconds ?? fallback), 0);
  return {
    specs,
    fallback,
    totals: {
      specs: specs.length,
      its: specs.reduce((sum, x) => sum + x.its, 0),
      ciSeconds: Math.round(seconds * 10) / 10,
      untimed: specs.filter((x) => x.ciSeconds === null).length,
      estimatedMinutes: specs.length ? Math.ceil((seconds * CI_FACTOR + specs.length * SPEC_OVERHEAD_S) / 60) : 0,
    },
  };
}


function analyze({ erp, base, head, automation, mapFile }) {
  if (!erp || !base || !head || !automation) {
    throw new ImpactError('E_ARGS', 'need --erp <dir> --base <ref> --head <ref> --automation <dir>');
  }
  if (!fs.existsSync(path.join(automation, 'cypress', 'e2e'))) {
    throw new ImpactError('E_NO_AUTOMATION', `${automation} has no cypress/e2e`, 'Point --automation at a workstream-automation checkout.');
  }
  const map = loadMap(mapFile);
  const headSha = revParse(erp, head);
  revParse(erp, base);
  const mergeBase = git(erp, ['merge-base', base, head]).trim();
  const warnings = [];

  /* what changed, and where */
  const files = changedFiles(erp, mergeBase, headSha);
  const areaByFile = {};
  const areas = {};
  for (const f of files.all) {
    const a = areaOf(map, f.path);
    areaByFile[f.path] = a;
    if (!areas[a.area]) areas[a.area] = { area: a.area, kind: a.kind, files: 0, e2e: a.e2e || [], pages: a.pages || [] };
    areas[a.area].files += 1;
  }
  for (const a of Object.values(areas)) {
    if (a.kind === 'unmapped') warnings.push(`${a.area} is in no list of modules-map.json; add it to frontend/backend, shared or uncovered`);
    for (const m of a.e2e) if (!fs.existsSync(path.join(automation, 'cypress/e2e', m))) warnings.push(`${a.area} maps to cypress/e2e/${m}, which does not exist`);
    for (const p of a.pages) if (!fs.existsSync(path.join(automation, 'cypress/Pages', p))) warnings.push(`${a.area} maps to cypress/Pages/${p}, which does not exist`);
  }
  const modules = uniq(Object.values(areas).flatMap((a) => (a.kind === 'mapped' ? a.e2e : [])));

  /* testids: the testIds.js files themselves */
  const idsBase = testIdsAt(erp, mergeBase);
  const idsHead = testIdsAt(erp, headSha);
  const flat = (exp) => Object.assign({}, ...Object.values(exp || {}));
  const added = []; const removed = []; const changed = [];
  const provenance = new Map();
  const note = (value, area) => { if (!provenance.has(value)) provenance.set(value, new Set()); provenance.get(value).add(area); };
  for (const f of files.frontend.filter((p) => TESTIDS_FILE.test(p))) {
    const before = flat(idsBase[files.all.find((x) => x.path === f).from || f]);
    const after = flat(idsHead[f]);
    const beforeVals = new Set(Object.values(before));
    const afterVals = new Set(Object.values(after));
    const area = areaByFile[f].area;
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before) && !beforeVals.has(value)) { added.push({ value, key, file: f }); note(value, area); }
      if (key in before && before[key] !== value) { changed.push({ key, file: f, from: before[key], to: value }); note(before[key], area); note(value, area); }
    }
    for (const [key, value] of Object.entries(before)) {
      if (!(key in after) && !afterVals.has(value)) { removed.push({ value, key, file: f }); note(value, area); }
    }
  }

  /* testids: the component lines the diff touched */
  const components = files.all.filter((f) => f.path.startsWith('frontend/') && CODE_FILE.test(f.path)
    && !TESTIDS_FILE.test(f.path) && areaByFile[f.path].kind !== 'ignored');
  const blobs = showMany(erp, components.flatMap((f) => [`${mergeBase}:${f.from || f.path}`, `${headSha}:${f.path}`]));
  const lines = diffLines(erp, mergeBase, headSha, components.map((f) => f.path));
  const referenced = new Map();
  const unresolved = [];
  const plusValues = new Set();
  const minusByFile = new Map();
  /** Every testid each changed component renders at the head, changed line or not. */
  const renders = new Map();
  for (const f of components) {
    const src = { base: blobs.get(`${mergeBase}:${f.from || f.path}`), head: blobs.get(`${headSha}:${f.path}`) };
    const local = { base: resolverFor(f.from || f.path, src.base, idsBase), head: resolverFor(f.path, src.head, idsHead) };
    const d = lines[f.path] || { plus: [], minus: [] };
    const plus = referencesIn(d.plus.join('\n'), local.head);
    const minus = referencesIn(d.minus.join('\n'), local.base);
    for (const v of [...plus.values, ...minus.values]) {
      if (!referenced.has(v)) referenced.set(v, new Set());
      referenced.get(v).add(f.path);
      note(v, areaByFile[f.path].area);
    }
    for (const v of plus.values) plusValues.add(v);
    const stillThere = referencesIn(src.head || '', local.head).values;
    if (src.head && stillThere.size) renders.set(f.path, stillThere);
    minusByFile.set(f.path, [...minus.values].filter((v) => !stillThere.has(v)));
    for (const r of uniq([...plus.unresolved, ...minus.unresolved])) unresolved.push({ ref: r, file: f.path });
  }

  /* automation: who selects what */
  const index = selectorIndex(automation);
  const selectedBy = new Map();
  for (const [f, vals] of index) for (const v of vals) { if (!selectedBy.has(v)) selectedBy.set(v, new Set()); selectedBy.get(v).add(f); }
  const erpFolders = new Map();
  for (const ids of [idsBase, idsHead]) {
    for (const [f, exp] of Object.entries(ids)) {
      const folder = f.startsWith(COMPONENTS) ? f.slice(COMPONENTS.length).split('/')[0] : f;
      for (const v of Object.values(flat(exp))) { if (!erpFolders.has(v)) erpFolders.set(v, new Set()); erpFolders.get(v).add(folder); }
    }
  }
  /**
   * Not unique enough to name one screen. `add-task-button` is selected only under
   * Pages/projectLogs, but kanban_board defined it too, so deleting the kanban board
   * matched every project-logs spec until the ERP side was counted as well.
   */
  // utils/ and fixtures/ are not screens, so a selector that also lives in a
  // helper or a fixture must not count as another folder toward "generic".
  const screenFolders = (v) => new Set([...(selectedBy.get(v) || [])]
    .map(folderOf).filter((d) => d !== 'utils' && d !== 'fixtures'));
  const isGeneric = (v) => screenFolders(v).size >= GENERIC_FOLDERS
    || (erpFolders.get(v) || new Set()).size >= 2;
  /** May page object `f` be the screen whose testid `v` changed? See the header. */
  const allowed = (f, v) => {
    if (!isGeneric(v)) return true;
    for (const a of provenance.get(v) || []) {
      const info = areas[a];
      if (!info || info.kind === 'shared') return true;
      if (info.pages.some((p) => f.startsWith(`cypress/Pages/${p}/`))) return true;
    }
    return false;
  };
  const hits = new Map();
  for (const v of provenance.keys()) {
    for (const f of selectedBy.get(v) || []) {
      if (!allowed(f, v)) continue;
      if (!hits.has(f)) hits.set(f, new Set());
      hits.get(f).add(v);
    }
  }

  /* specs */
  const specFiles = walk(automation, 'cypress/e2e', (r) => /\.[jt]s$/.test(r)).sort();
  const selected = [];
  const importsOf = new Map();
  const tagsOf = new Map();
  for (const file of specFiles) {
    const mod = file.split('/')[2];
    const src = fs.readFileSync(path.join(automation, file), 'utf8');
    tagsOf.set(file, specTags(src));
    const imports = directImports(automation, file, src, index);
    importsOf.set(file, imports);
    const reasons = [];
    if (modules.includes(mod)) {
      const via = Object.values(areas).filter((a) => a.kind === 'mapped' && a.e2e.includes(mod)).map((a) => a.area);
      reasons.push(`module ${mod} (${via.join(', ')})`);
    }
    for (const f of [...imports].sort()) {
      if (hits.has(f)) reasons.push(`imports ${f}, which selects ${[...hits.get(f)].sort().map((v) => `'${v}'`).join(', ')}`);
    }
    if (reasons.length) selected.push({ file, module: mod, reasons });
  }
  const cost = costOf(automation, selected.map((x) => x.file));
  const main = mainSpecsOf(modules, specFiles, tagsOf);
  const isMain = new Set(main.map((m) => m.file));
  const specs = selected.map((x, i) => {
    const { its, ciSeconds, destructive } = cost.specs[i];
    const smoke = (tagsOf.get(x.file) || []).includes('smoke');
    return { file: x.file, module: x.module, its, ciSeconds, destructive, smoke, main: isMain.has(x.file), reasons: x.reasons };
  });
  const byFile = new Map(specs.map((x) => [x.file, x]));
  const mainSpecs = main.map((m) => {
    const x = byFile.get(m.file);
    return { file: m.file, module: m.module, basis: m.basis, its: x.its, ciSeconds: x.ciSeconds, destructive: x.destructive };
  });

  /* specs that open a screen the change touched (see the header) */
  const allowedRender = (po, v, file) => {
    if (!isGeneric(v)) return true;
    const info = areas[areaByFile[file].area];
    return Boolean(info && info.kind === 'mapped' && info.pages.some((p) => po.startsWith(`cypress/Pages/${p}/`)));
  };
  const pageHits = new Map();
  for (const [file, vals] of renders) {
    for (const v of vals) {
      for (const po of selectedBy.get(v) || []) {
        if (!allowedRender(po, v, file)) continue;
        const h = pageHits.get(po) || { values: new Set(), screens: new Set() };
        h.values.add(v);
        h.screens.add(file);
        pageHits.set(po, h);
      }
    }
  }
  const taken = new Set([...specs.filter((x) => x.reasons.some((r) => !r.startsWith('module '))).map((x) => x.file), ...isMain]);
  const screenAll = [];
  for (const file of specFiles) {
    if (taken.has(file)) continue;
    const via = [...importsOf.get(file)].filter((po) => pageHits.has(po)).sort();
    if (!via.length) continue;
    const values = new Set(via.flatMap((po) => [...pageHits.get(po).values]));
    const screens = new Set(via.flatMap((po) => [...pageHits.get(po).screens]));
    screenAll.push({ file, module: file.split('/')[2], screens: [...screens].sort(), via, matched: values.size });
  }
  const impacted = (x) => (modules.includes(x.module) ? 1 : 0);
  screenAll.sort((a, b) => (impacted(b) - impacted(a)) || (b.matched - a.matched) || byCase(a.file, b.file));
  const screenTop = screenAll.slice(0, MAX_SCREEN_SPECS);
  const screenCost = costOf(automation, screenTop.map((x) => x.file));
  const screenSpecs = screenTop.map((x, i) => ({
    ...x, its: screenCost.specs[i].its, ciSeconds: screenCost.specs[i].ciSeconds, destructive: screenCost.specs[i].destructive,
  }));
  const specsImporting = (pageObjects) => specFiles.filter((s) => pageObjects.some((p) => importsOf.get(s).has(p)));

  /* what will break, and what nothing covers */
  const definedAtHead = (v) => Object.keys(idsHead).filter((f) => Object.values(flat(idsHead[f])).includes(v));
  const removedTestidStillUsed = [];
  const dropped = [
    ...removed.map((r) => ({ value: r.value, file: r.file, source: 'testIds', renamedTo: null })),
    ...changed.filter((c) => !definedAtHead(c.from).includes(c.file))
      .map((c) => ({ value: c.from, file: c.file, source: 'testIds', renamedTo: c.to })),
    ...[...minusByFile].flatMap(([file, vals]) => vals.filter((v) => !plusValues.has(v))
      .map((value) => ({ value, file, source: 'component', renamedTo: null }))),
  ];
  const seen = new Set();
  for (const d of dropped) {
    const pageObjects = [...(selectedBy.get(d.value) || [])].filter((f) => allowed(f, d.value)).sort();
    if (!pageObjects.length || seen.has(d.value)) continue;
    seen.add(d.value);
    removedTestidStillUsed.push({ ...d, stillDefinedIn: definedAtHead(d.value), pageObjects, specs: specsImporting(pageObjects) });
  }
  const addedTestidUnused = [
    ...added.map((a) => ({ value: a.value, key: a.key, file: a.file })),
    ...changed.map((c) => ({ value: c.to, key: c.key, file: c.file })),
  ].filter((a) => !selectedBy.has(a.value))
    .map((a) => ({ ...a, usedBy: [...(referenced.get(a.value) || [])].sort() }));

  const automationSha = spawnSync('git', ['-C', automation, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return {
    erp: { base, head, mergeBase, headSha },
    automation: { dir: automation, sha: automationSha.status === 0 ? automationSha.stdout.trim() : null },
    changedFiles: files,
    areas: Object.values(areas).sort((a, b) => a.area.localeCompare(b.area)),
    modules,
    testids: {
      added: added.sort((a, b) => a.value.localeCompare(b.value)),
      removed: removed.sort((a, b) => a.value.localeCompare(b.value)),
      changed: changed.sort((a, b) => a.key.localeCompare(b.key)),
      referenced: [...referenced].map(([value, fs_]) => ({ value, files: [...fs_].sort() })).sort((a, b) => a.value.localeCompare(b.value)),
      unresolved,
      generic: uniq([...provenance.keys()].filter(isGeneric)),
    },
    specs,
    mainSpecs,
    mainTotals: costOf(automation, mainSpecs.map((m) => m.file)).totals,
    screenSpecs,
    screenSpecsTotal: screenAll.length,
    removedTestidStillUsed,
    addedTestidUnused,
    totals: cost.totals,
    timingFallbackSeconds: cost.fallback,
    warnings,
  };
}

/**
 * Every folder the map names, checked against both trees. The map is a snapshot of two
 * repos that keep moving; this is how drift gets found before a ticket trips on it.
 */
function checkMap({ erp, ref, automation, mapFile }) {
  const map = loadMap(mapFile);
  const missing = [];
  const dirs = erp ? new Set(git(erp, ['ls-tree', '-r', '-d', '--name-only', ref || 'HEAD', '--', 'frontend/src/components', 'apps']).split('\n')) : null;
  for (const side of ['frontend', 'backend']) {
    const root = side === 'frontend' ? COMPONENTS : 'apps/';
    const named = [...Object.keys(map[side]), ...(map.shared[side] || []), ...(map.uncovered[side] || [])];
    if (dirs) for (const k of named) if (!dirs.has(`${root}${k}`)) missing.push(`erp ${root}${k}`);
    for (const [k, v] of Object.entries(map[side])) {
      for (const m of v.e2e) if (!fs.existsSync(path.join(automation, 'cypress/e2e', m))) missing.push(`${side}:${k} -> cypress/e2e/${m}`);
      for (const p of v.pages) if (!fs.existsSync(path.join(automation, 'cypress/Pages', p))) missing.push(`${side}:${k} -> cypress/Pages/${p}`);
    }
  }
  if (dirs) {
    for (const d of dirs) {
      const m = d.match(/^(frontend\/src\/components|apps)\/([^/]+)$/);
      if (!m) continue;
      const side = m[1] === 'apps' ? 'backend' : 'frontend';
      const top = m[2];
      const listed = Object.keys(map[side]).some((k) => k.split('/')[0] === top)
        || (map.shared[side] || []).includes(top) || (map.uncovered[side] || []).includes(top)
        || map.ignoreRes.some((re) => re.test(`${d}/`));
      if (!listed && top !== '__pycache__') missing.push(`unlisted ${d}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ cli */

function summary(r) {
  const c = r.changedFiles;
  const out = [
    `ERP ${r.erp.base}...${r.erp.head} (merge-base ${r.erp.mergeBase.slice(0, 10)}): ${c.all.length} files `
      + `(${c.frontend.length} frontend, ${c.backend.length} backend, ${c.migrations.length} migrations, ${c.other.length} other)`,
    ...r.areas.map((a) => `  ${a.area} [${a.kind}] ${a.files} file(s)${a.e2e.length ? ` -> ${a.e2e.join(', ')}` : ''}`),
    `modules: ${r.modules.join(', ') || 'none'}`,
    `testids: +${r.testids.added.length} -${r.testids.removed.length} ~${r.testids.changed.length}, `
      + `${r.testids.referenced.length} referenced, ${r.testids.unresolved.length} unresolved, ${r.testids.generic.length} generic`,
    `specs: ${r.totals.specs} (${r.totals.its} it blocks, ${r.totals.ciSeconds}s in CI, ${r.totals.untimed} untimed) ~${r.totals.estimatedMinutes} min`,
    `main functionality: ${r.mainSpecs.length} spec(s) ~${r.mainTotals.estimatedMinutes} min`,
    ...r.mainSpecs.map((m) => `  ${m.file} [${m.basis === 'smoke' ? 'smoke' : 'first in module'}]`),
    `open a changed screen: ${r.screenSpecsTotal} spec(s)${r.screenSpecsTotal > r.screenSpecs.length ? `, first ${r.screenSpecs.length} listed` : ''}`,
    ...r.screenSpecs.map((x) => `  ${x.file} [${x.matched} testid(s) via ${x.via.join(', ')}]`),
    `removed but still selected: ${r.removedTestidStillUsed.map((x) => `${x.value} (${x.specs.length} specs)`).join(', ') || 'none'}`,
    `added, selected by no page object: ${r.addedTestidUnused.map((x) => x.value).join(', ') || 'none'}`,
    ...r.warnings.map((w) => `warning: ${w}`),
  ];
  return out.join('\n');
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (!m) { a._.push(argv[i]); continue; }
    if (m[1] === 'json') a.json = true;
    else { a[m[1]] = argv[i + 1]; i += 1; }
  }
  return a;
}

/** The session's final list, priced the way analyze() priced the candidates. */
function estimate({ automation, specs }) {
  if (!automation || !fs.existsSync(path.join(automation, 'cypress', 'e2e'))) {
    throw new ImpactError('E_NO_AUTOMATION', `${automation} has no cypress/e2e`, 'Point --automation at a workstream-automation checkout.');
  }
  const wanted = uniq(specs.map((f) => f.trim()).filter(Boolean));
  const present = wanted.filter((f) => fs.existsSync(path.join(automation, f)));
  const cost = costOf(automation, present);
  return { specs: cost.specs, missing: wanted.filter((f) => !present.includes(f)), totals: cost.totals, timingFallbackSeconds: cost.fallback };
}

module.exports = {
  analyze, checkMap, estimate, costOf, ImpactError,
  /** Internals, exported for src/lib/local-tests-impact.test.ts. */
  stripComments, countIts, isDestructive, parseTestIds, selectorTestids, referencesIn, resolverFor, areaOf, loadMap,
  specTags, caseNumber, byCase, mainSpecsOf, GENERIC_FOLDERS, MAIN_SPECS_PER_MODULE, MAX_SCREEN_SPECS,
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const print = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (args._[0] === 'check-map') {
      const r = checkMap({ erp: args.erp, ref: args.ref, automation: args.automation, mapFile: args.map });
      print(r);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (args._[0] === 'estimate') {
      const listed = args.specs ? fs.readFileSync(args.specs, 'utf8').split('\n') : [];
      const r = estimate({ automation: args.automation, specs: [...listed, ...args._.slice(1)] });
      print(r);
      if (r.missing.length) process.exitCode = 1;
      return;
    }
    if (args._.length || !Object.keys(args).some((k) => k !== '_' && k !== 'json')) {
      console.log(`index.cjs — which workstream-automation specs an ERP diff reaches

  node index.cjs --erp <erp repo> --base <ref> --head <ref> --automation <wsa dir> [--json]
  node index.cjs estimate --automation <wsa dir> [--specs <file of paths>] [<spec> ...]
  node index.cjs check-map --automation <wsa dir> [--erp <erp repo> --ref <ref>]

Read-only on both repos: git diff/ls-tree/cat-file on the ERP side, plain reads of
cypress/ on the automation side. --map <file> swaps modules-map.json.`);
      return;
    }
    const r = analyze({ erp: args.erp, base: args.base, head: args.head, automation: args.automation, mapFile: args.map });
    if (args.json) print(r);
    else console.log(summary(r));
  } catch (err) {
    print(err instanceof ImpactError ? err.toJSON() : { code: 'E_GIT', message: String((err && err.message) || err) });
    process.exitCode = 1;
  }
}

if (require.main === module) main();
