#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: keep this repo's .env out of a session.
 *
 * WHAT THIS IS NOT PROTECTING AGAINST. `GITLAB_TOKEN` never reaches a phase.
 * The session environment in src/lib/config.ts is a WHITELIST — PATH, HOME,
 * LANG, ONESHOT_HOME and the identity variables — so `echo $GITLAB_TOKEN`
 * prints an empty line, and the token travels only into the MCP server's own
 * subprocess. The skills' "never print GITLAB_TOKEN" rule is already true by
 * construction for the environment.
 *
 * WHAT IT IS. The one path left is the file. `.env` is mode 600 and the phase
 * runs as its owner, so `cat`, `grep`, a Read or Grep tool call or a
 * heredoc-free `sed -n` all reach it, and everything a phase prints goes into a
 * transcript that outlives the run. This closes that, and nothing else — a
 * guard that tried to catch every way a secret could be echoed would be a guard
 * nobody could reason about. It is best-effort against a phase reaching for the
 * file, not a sandbox: `sudo cat`, `python -c open(...)` and friends are not
 * parsed, which is why the skills still carry "never print GITLAB_TOKEN".
 *
 * Writes are denied too, by redirect as much as by `sed -i`. A blind `>` over
 * this file blanks GITLAB_TOKEN and every later session on the machine starts
 * with no GitLab tools; fixing a credential here is an operator's job.
 *
 * Scoped to this repo's own .env. A work repo's .env belongs to the app the
 * phase is there to run, and blocking it would break bringing that app up.
 *
 * THE CYPRESS CREDENTIALS are the second subject, held to a stricter rule.
 * The local-tests step runs workstream-automation's specs with a credentials
 * file kept on Oneshot's side (ONESHOT_LOCAL_TESTS_CREDS), and
 * workstream-automation TRACKS its own cypress.env.json — so the automation
 * clone and every run's state/runs/<iid>/wsa and wsa-run worktree have one on
 * disk, and ignore rules do not skip it. The wsa copy is the committed one; the
 * wsa-run copy is the run step's merge with the desk credentials, and people
 * fill the clone's tracked copy in locally. No session needs any of them: the
 * run step hands the values to Cypress itself. So here the rule is the name,
 * not the verb: a Bash segment that names one is denied unless it only lists
 * or tests for it. That also catches the interpreter one-liners the .env rule
 * leaves alone — `python3 -c "import json; print(json.load(open(p)))"` splits
 * at its `;` and loses its verb. A search that would open one without naming
 * it (the Grep tool's content mode, or a recursive grep/rg/git grep rooted
 * where the file sits) is denied too, and so is git that prints the clone's or
 * a wsa-run's working tree as a patch (`git diff`, `git show`, `log -p`) with
 * no pathspec leaving the file out. The way out is the narrower command the
 * session wanted anyway.
 *
 * Brace expansion is judged by what it expands to (`cat *.{json,ts}`), and a
 * segment whose judging throws is refused when a credentials file could be in
 * reach of it rather than waved through with the rest of the command.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep']);
const ENV_FILE = path.join(C.ONESHOT, '.env');
const HOME = os.homedir();

const DENIAL =
  `Denied: ${ENV_FILE} holds this machine's credentials, and everything a phase prints ` +
  'lands in a transcript that outlives the run.\n' +
  'Nothing here needs it: the session environment is a whitelist, so the token is not in ' +
  'your environment either — it goes straight to the GitLab MCP server, which is how the ' +
  'mcp__gitlab__* tools are already authenticated for you. Use those tools.\n' +
  'Writing it is denied for the same reason: a credential in this file that is missing, ' +
  'wrong or expired is a human fix, not a phase\'s — including `remediate`\'s.\n' +
  'If something genuinely cannot proceed without a credential, report that in `blocked` ' +
  '(or `humanNeeded`: the variable and what it should be, never its value); ' +
  'an operator resolves it, not you.';

/** A candidate path must END at `.env`, so `.env.example` and `.env.local` are not it. */
const CANDIDATE = /(?:^|[\s'"<>|])([^\s'"<>|]*\.env)(?=$|[\s'"<>|])/g;
const READER = /^\s*(cat|bat|less|more|head|tail|grep|egrep|rg|awk|sed|cut|sort|strings|xxd|od|open|cp|scp|rsync|source|\.)\b/;
const WRITER = /^\s*(tee|dd|truncate|mv|ln|install)\b/;

/** Expand what the shell would: `~`, $HOME and $ONESHOT_HOME, braced or not. */
function expand(candidate) {
  return candidate
    .replace(/^[A-Za-z_]+=/, '') // dd's of=/if=
    .replace(/^~(?=\/|$)/, HOME)
    .replace(/\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/g, HOME)
    .replace(/\$(?:\{ONESHOT_HOME\}|ONESHOT_HOME(?![A-Za-z0-9_]))/g, C.ONESHOT);
}

/** Split a command line on the separators a shell treats as a new command. */
function segments(command) {
  return command.split(/(?:\|\||&&|[;|\n])/g).map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------- cypress credentials

const CYPRESS_ENV = 'cypress.env.json';
const CREDS = C.localTests().creds;
const CREDS_REAL = C.realish(CREDS).toLowerCase();
const CREDS_DIR = C.realish(path.dirname(CREDS));
/** Commands that report on a file without opening it. */
const INERT = new Set(['ls', 'stat', 'test', '[', '[[', 'file']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
/** What can stand in front of argv[0] without changing what runs. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'nohup', 'time']);

const CREDS_DENIAL =
  'Denied: that would reveal Cypress credentials — a cypress.env.json (workstream-automation ' +
  'tracks one, so the automation clone and every state/runs/<iid>/wsa and wsa-run worktree has ' +
  'it, and the clone\'s and wsa-run\'s hold real values) or this desk\'s local-tests credentials ' +
  'file. Everything a phase prints lands in a transcript that outlives the run.\n' +
  'Nothing in a session needs the values: the local-tests run step hands them to Cypress itself. ' +
  'To see which keys a spec reads, grep the specs for `Cypress.env(` under cypress/. To search the ' +
  'repo, name cypress/ (or a narrower directory) rather than its root, or leave the file out ' +
  '(`--exclude=cypress.env.json`, `-g \'!cypress.env.json\'`, a Grep `glob`). A `git diff`, ' +
  '`git show` or `git log -p` in the clone or a wsa-run prints that file\'s local changes without ' +
  'naming it: give it a pathspec (`-- cypress/`, or `-- . \':!cypress.env.json\'`), or use ' +
  '`--stat`/`--name-only`. Listing or testing for it (`ls`, `test -f`) is fine.\n' +
  'If something genuinely cannot proceed without a credential, report that in `blocked` — the ' +
  'key\'s name, never its value.';

/** The automation worktrees a run directory holds: the scope session's, and the run step's. */
const RUN_CHECKOUTS = ['wsa', 'wsa-run'];

/** C.isInside, case-folded: on this APFS volume STATE/runs IS state/runs. */
function within(child, parent) {
  const c = C.realish(child).toLowerCase();
  const p = C.realish(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** A shell or ripgrep glob as a case-folded RegExp: `*`, `**`, `?` and `{a,b}`. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{' || ch === '}' || ch === ',') {
      re += { '{': '(?:', '}': ')', ',': '|' }[ch];
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * globRe(), or null for a pattern that does not compile — an unbalanced `{`.
 * That used to throw out of the guard, whose catch allowed the WHOLE command.
 */
function tryGlobRe(glob) {
  try {
    return globRe(glob);
  } catch {
    return null;
  }
}

/**
 * Does a filter glob take in `rel`? One with no slash is matched against the
 * basename, as ripgrep does. `unknown` answers for a glob that does not
 * compile, and the caller picks the safe side: an include takes it in, an
 * exclude leaves nothing out.
 */
function globTakes(glob, rel, unknown) {
  const re = tryGlobRe(glob);
  if (!re) return unknown;
  return re.test(glob.includes('/') ? rel : path.basename(rel));
}

/** Split a word on the commas a shell would: `a,b` is two words, `*.{json,ts}` is one. */
function splitTopCommas(word) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(word.slice(start, i));
      start = i + 1;
    }
  }
  out.push(word.slice(start));
  return out;
}

/**
 * The words a shell's brace expansion makes of `word`: `cypress.env.{json,x}`
 * is `cypress.env.json` and `cypress.env.x`. Only a group with a comma at its
 * own level expands, as in bash; `${VAR}` and `{x}` stay as they are, and so
 * does an unbalanced brace. Capped, because the words multiply.
 */
function expandBraces(word, limit = 64) {
  const out = [];
  const go = (w) => {
    if (out.length >= limit) return;
    for (let i = 0; i < w.length; i += 1) {
      if (w[i] !== '{' || w[i - 1] === '$') continue;
      let depth = 0;
      let end = -1;
      const commas = [];
      for (let j = i; j < w.length; j += 1) {
        if (w[j] === '{') depth += 1;
        else if (w[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        } else if (w[j] === ',' && depth === 1) commas.push(j);
      }
      if (end === -1) break;
      if (!commas.length) continue;
      const pre = w.slice(0, i);
      const post = w.slice(end + 1);
      let from = i + 1;
      for (const c of [...commas, end]) {
        go(pre + w.slice(from, c) + post);
        from = c + 1;
      }
      return;
    }
    out.push(w);
  };
  go(word);
  // Past the cap, the word itself goes too: judged as written, it is judged conservatively.
  return out.length >= limit ? [...out, word] : out;
}

/**
 * Is `abs` a credentials file? Any cypress.env.json, by the name as typed or
 * as it resolves, or this desk's credentials file. Case-folded: on APFS
 * Cypress.ENV.json is the same file.
 */
function credsFile(abs) {
  if (path.basename(abs).toLowerCase() === CYPRESS_ENV) return true;
  const real = C.realish(abs).toLowerCase();
  return path.basename(real) === CYPRESS_ENV || real === CREDS_REAL;
}

/**
 * The credentials files a search rooted at `dir` opens, relative to it: a
 * cypress.env.json at the top (the clone, a wsa or wsa-run worktree) or under
 * wsa/ or wsa-run/ (a run directory), and the credentials file when `dir` is
 * its folder. Nothing deeper is looked for; a tree walk on every search would
 * cost more than the guard is worth.
 *
 * The one exception is `deep`, for `grep -r`: it honours no ignore file, so
 * from at or above state/runs it opens every run's worktrees — wsa-run's
 * included, which is the one holding the desk credentials while a run is in
 * progress. ripgrep and the Grep tool skip state/ as ignored, and are not
 * asked about it.
 */
function reachable(dir, deep = false) {
  const found = [CYPRESS_ENV, ...RUN_CHECKOUTS.map((n) => path.join(n, CYPRESS_ENV))]
    .filter((rel) => fs.existsSync(path.join(dir, rel)));
  if (fs.existsSync(CREDS) && CREDS_DIR === C.realish(dir)) {
    found.push(path.basename(CREDS));
  }
  const runs = path.join(C.STATE, 'runs');
  if (deep && fs.existsSync(runs) && C.isInside(runs, dir)) {
    for (const iid of fs.readdirSync(runs)) {
      for (const n of RUN_CHECKOUTS) {
        const file = path.join(runs, iid, n, CYPRESS_ENV);
        if (fs.existsSync(file)) found.push(path.relative(C.realish(dir), C.realish(file)));
      }
    }
  }
  return found;
}

/** Grep tool: the file a content-mode search of `dir` would print lines of, or undefined. */
function grepReveals(input, dir) {
  if (input.output_mode !== 'content') return undefined;
  return reachable(dir).find((rel) => {
    if (input.type && String(input.type).toLowerCase() !== 'json') return false;
    const glob = String(input.glob || '');
    if (!glob) return true;
    return glob.startsWith('!') ? !globTakes(glob.slice(1), rel, false) : globTakes(glob, rel, true);
  });
}

/**
 * Does this word name a credentials file? A word with a glob in its last part
 * is judged by what it would expand to, so `cat *.json` in the clone counts.
 * One that does not compile names it whenever its directory holds one.
 */
function namesCreds(word, here) {
  const w = expand(word);
  const abs = path.resolve(here, w);
  const name = path.basename(w);
  if (!/[*?[]/.test(name)) return credsFile(abs);
  const re = tryGlobRe(name);
  const dir = path.dirname(abs);
  const holdsCypress = fs.existsSync(path.join(dir, CYPRESS_ENV));
  const holdsCreds = C.realish(dir) === CREDS_DIR;
  if (!re) return holdsCypress || (holdsCreds && fs.existsSync(CREDS));
  return (re.test(CYPRESS_ENV) && holdsCypress) || (re.test(path.basename(CREDS)) && holdsCreds);
}

/**
 * The path-shaped words of a segment: split where a shell or an interpreter
 * would quote, with `rev:path` and `--opt=path` taken apart and brace groups
 * expanded. A comma splits a word only outside braces, so `*.{json,ts}` stays
 * one pattern rather than becoming `*.{json` and `ts}`. A word that EXCLUDES a
 * file (`--exclude=…`, ripgrep's `!…`, git's `:!…`) is dropped — that is the
 * search being narrowed, which is what the denial asks for.
 */
function pathWords(seg) {
  const out = [];
  for (const raw of seg.split(/[\s'"`<>|;&()]+/)) {
    for (const word of splitTopCommas(raw)) {
      if (!word || /^--exclude(?:-dir)?=/.test(word)) continue;
      for (const part of word.replace(/^[\w.-]*=/, '').split(':')) {
        if (part && !part.startsWith('!')) out.push(...expandBraces(part));
      }
    }
  }
  return out;
}

/** The include/exclude/type filters a grep, rg or git grep narrows itself with. */
function searchFilters(args) {
  const f = { includes: [], excludes: [], types: [] };
  const glob = (g) => (g.startsWith('!') ? f.excludes.push(g.slice(1)) : f.includes.push(g));
  args.forEach((a, i) => {
    const next = args[i + 1] || '';
    const m = a.match(/^--(include|exclude|glob|type)=(.+)$/);
    if (m && m[1] === 'glob') glob(m[2]);
    else if (m && m[1] === 'type') f.types.push(m[2]);
    else if (m) f[`${m[1]}s`].push(m[2]);
    else if (a === '-g' || a === '--glob') glob(next);
    else if (a === '-t' || a === '--type') f.types.push(next);
    else if (/^:(?:!|\^|\(exclude\))./.test(a)) f.excludes.push(a.replace(/^:(?:!|\^|\(exclude\))/, ''));
  });
  return f;
}

/**
 * A recursive search that opens a credentials file without naming it: `grep
 * -rn baseUrl .` or `rg password` in the clone, `git grep` in a wsa worktree.
 * Its roots are the directories it names, or where it stands when it names
 * none. Returns the file, or null.
 */
function searchReveals(argv0, rest, here) {
  let args = rest;
  let base = here;
  if (argv0 === 'git') {
    const i = rest.findIndex((a, k) => !a.startsWith('-') && !['-C', '-c'].includes(rest[k - 1]));
    if (rest[i] !== 'grep') return null;
    rest.slice(0, i).forEach((a, k) => {
      if (a === '-C') base = path.resolve(base, expand(rest[k + 1] || '.'));
    });
    args = rest.slice(i + 1);
  } else if (!SEARCHERS.has(argv0)) {
    return null;
  } else if (/grep$/.test(argv0)
    && !args.some((a) => /^-[^-]*[rR]/.test(a) || /^--(?:dereference-)?recursive$/.test(a))) {
    return null;
  }
  // Names only, like the Grep tool's files_with_matches: `-l`, `-L`, `-c` and their long forms.
  if (args.some((a) => /^-[^-]*[lLc]/.test(a)
    || /^--(?:files-with(?:out)?-matches?|name-only|count|files)$/.test(a))) {
    return null;
  }
  const given = args.filter((a) => !a.startsWith('-'))
    .map((a) => path.resolve(base, expand(a)))
    .filter((p) => fs.existsSync(p));
  const roots = given.length ? given.filter((p) => fs.statSync(p).isDirectory()) : [base];
  const f = searchFilters(args);
  for (const root of roots) {
    for (const rel of reachable(root, /grep$/.test(argv0))) {
      if (f.excludes.some((g) => globTakes(g, rel, false))) continue;
      if (f.includes.length && !f.includes.some((g) => globTakes(g, rel, true))) continue;
      if (f.types.length && !f.types.some((t) => t.toLowerCase() === 'json')) continue;
      return path.join(root, rel);
    }
  }
  return null;
}

// ------------------------------------------------------- git that prints a patch

/**
 * A git call's subcommand and arguments, the directory it runs in (moved by
 * each `-C`), and every directory it acts on: that one plus any --git-dir /
 * --work-tree or GIT_DIR / GIT_WORK_TREE it names. git-guard.cjs gitCall(),
 * which this mirrors, cannot be shared: a guard requires nothing but
 * _common.cjs.
 */
function gitCall(rest, vars, here) {
  let dir = here;
  const named = [vars.GIT_DIR, vars.GIT_WORK_TREE].filter(Boolean);
  let i = 0;
  for (; i < rest.length && rest[i].startsWith('-'); i += 1) {
    const a = rest[i];
    const eq = a.match(/^--(?:git-dir|work-tree)=(.+)$/);
    if (a === '-C') {
      i += 1;
      dir = path.resolve(dir, expand(rest[i] || '.'));
    } else if (a === '--git-dir' || a === '--work-tree') {
      i += 1;
      named.push(rest[i] || '.');
    } else if (a === '-c' || a === '--namespace' || a === '--config-env') {
      i += 1;
    } else if (eq) {
      named.push(eq[1]);
    }
  }
  return {
    sub: rest[i] || '',
    args: rest.slice(i + 1),
    dir,
    dirs: [dir, ...named.map((p) => path.resolve(dir, expand(p)))],
  };
}

/** Diff options that print a patch; with any of them a stat-only option prints one too. */
const PATCH_OPTS = /^(?:-p|-u|--patch|--patch-with-stat|--patch-with-raw|-U\d*|--unified(?:=.*)?|--cc|-c|--word-diff(?:=.*)?|--color-words(?:=.*)?|--binary|--check)$/;
/** Diff options that print names or counts instead of a patch. */
const STAT_OPTS = /^(?:--stat(?:=.*)?|--numstat|--shortstat|--compact-summary|--dirstat(?:=.*)?|--summary|--name-only|--name-status|--raw|--quiet|--no-patch|-s)$/;

/** Does this git subcommand, with these arguments, print file contents as a patch? */
function printsPatch(sub, args) {
  const patch = args.some((a) => PATCH_OPTS.test(a));
  const statOnly = args.some((a) => STAT_OPTS.test(a));
  switch (sub) {
    case 'diff':
    case 'show':
      return patch || !statOnly;
    case 'log':
    case 'whatchanged':
    case 'diff-tree':
    case 'diff-files':
    case 'diff-index':
      return patch;
    case 'stash':
      return args.find((a) => !a.startsWith('-')) === 'show' && patch;
    case 'add':
      return args.some((a) => /^(?:-p|--patch|-i|--interactive|-e|--edit)$/.test(a));
    case 'format-patch':
    case 'range-diff':
      return true;
    default:
      return false;
  }
}

/**
 * The top of the checkout `p` is in when that checkout's working tree holds
 * real credentials: the clone (people fill its tracked cypress.env.json in
 * locally) or a run's wsa-run (the run step's merge with the desk
 * credentials). A run's wsa holds only the committed copy, and diffing it is
 * how the scope session cuts its patch, so it is not one of them.
 */
function credsCheckout(p) {
  const { repo } = C.localTests();
  if (repo && within(p, repo)) return C.realish(repo);
  const runs = C.realish(path.join(C.STATE, 'runs'));
  const rel = path.relative(runs.toLowerCase(), C.realish(p).toLowerCase());
  const parts = rel.split(path.sep);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || parts[1] !== 'wsa-run') return null;
  return path.join(runs, parts[0], 'wsa-run');
}

/** A pathspec with its exclusion magic taken off: `:!x` → `x`, `:(exclude,top)x` → `:(top)x`. */
function unexcluded(spec) {
  const long = spec.match(/^:\(([^)]*)\)(.*)$/);
  if (long) {
    const sig = long[1].split(',').filter((w) => w && w !== 'exclude');
    return sig.length ? `:(${sig.join(',')})${long[2]}` : long[2];
  }
  const short = spec.match(/^:([/!^]*)(.*)$/);
  if (!short) return spec;
  const sig = short[1].replace(/[!^]/g, '');
  return (sig ? `:${sig}` : '') + short[2];
}

/** Does git pathspec `spec`, given from `dir`, take in `<top>/cypress.env.json`? */
function specTakes(spec, dir, top) {
  let s = spec;
  let base = dir;
  const magic = s.match(/^:(?:\(([^)]*)\)|([/]*))(.*)$/);
  if (magic) {
    if (/\btop\b/.test(magic[1] || '') || (magic[2] || '').includes('/')) base = top;
    s = magic[3];
  }
  const file = path.join(top, CYPRESS_ENV);
  const g = s.search(/[*?[]/);
  if (g === -1) return within(file, path.resolve(base, expand(s || '.')));
  const slash = s.slice(0, g).lastIndexOf('/');
  const litDir = path.resolve(base, expand(slash === -1 ? '.' : s.slice(0, slash + 1)));
  if (!within(top, litDir)) return false;            // the pattern starts below the top
  if (!within(litDir, top)) return true;             // it starts above it
  const re = tryGlobRe(s.slice(slash + 1));
  return !re || re.test(CYPRESS_ENV);
}

/**
 * `git diff` in the clone or a wsa-run prints the working tree's credentials
 * as `+` lines and names no file, so the name rule never sees it; so do
 * `git diff HEAD`, `show`, `log -p` and the rest of printsPatch(). Refused
 * unless a pathspec leaves cypress.env.json out — `-- cypress/`, or
 * `-- . ':!cypress.env.json'` — which is the narrower command the denial asks
 * for. Returns the file it would print, or null.
 */
function gitReveals(rest, vars, here) {
  const call = gitCall(rest, vars, here);
  if (!printsPatch(call.sub, call.args)) return null;
  const dd = call.args.indexOf('--');
  const before = (dd === -1 ? call.args : call.args.slice(0, dd)).filter((a) => !a.startsWith('-'));
  // `git show <rev>:<path>` prints that one file, which the name rule has already judged.
  if (call.sub === 'show' && before.length && before.every((a) => /^[^:]+:/.test(a))) return null;
  const top = call.dirs.map(credsCheckout).find(Boolean);
  if (!top) return null;
  const base = within(call.dir, top) ? call.dir : top;
  // Without `--` an argument is a pathspec when it is one by magic or names something on disk.
  const specs = dd === -1
    ? before.filter((a) => a.startsWith(':') || fs.existsSync(path.resolve(base, expand(a))))
    : call.args.slice(dd + 1);
  const excluding = (s) => /^:(?:[/]*[!^]|\([^)]*\bexclude\b[^)]*\))/.test(s);
  if (specs.filter(excluding).some((s) => specTakes(unexcluded(s), base, top))) return null;
  const positive = specs.filter((s) => !excluding(s));
  if (positive.length && !positive.some((s) => specTakes(s, base, top))) return null;
  return path.join(top, CYPRESS_ENV);
}

/**
 * Could a credentials file be in reach of this segment? Asked only when
 * judging it threw: such a segment is refused rather than allowed, but only
 * where there is something to protect, so a bug cannot wedge every command.
 */
function inReach(segment, here) {
  if (/cypress/i.test(segment) || segment.includes(path.basename(CREDS))) return true;
  try {
    return reachable(here).length > 0;
  } catch {
    return true;
  }
}

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const input = data.tool_input || {};
  // Resolve against the session's cwd rather than matching the string, so a
  // bare `cat .env` is judged by where it would actually land: this repo's
  // file is denied, the work repo's is the app's own business.
  const cwd = data.cwd || process.env.ONESHOT_WORKTREE || C.ONESHOT;

  if (READ_TOOLS.has(tool)) {
    const target = expand(input.file_path || input.notebook_path || input.path || '');
    if (target && C.realish(target) === C.realish(ENV_FILE)) {
      C.event('denied_env_read', { tool, target });
      C.deny(DENIAL);
    }
    // A Grep with no path searches where the session stands.
    const abs = path.resolve(cwd, target || '.');
    if ((target && credsFile(abs)) || (tool === 'Grep' && grepReveals(input, abs))) {
      C.event('denied_cypress_creds', { tool, target: abs });
      C.deny(CREDS_DENIAL);
    }
  }

  // A Glob only lists names, so it is refused only when it hunts for the file itself.
  if (tool === 'Glob') {
    const pattern = String(input.pattern || '');
    const name = path.basename(pattern);
    const base = path.resolve(cwd, expand(input.path || '.'));
    const re = tryGlobRe(name);
    if ((/cypress/i.test(name) && (!re || re.test(CYPRESS_ENV)))
      || credsFile(path.resolve(base, expand(pattern)))) {
      C.event('denied_cypress_creds', { tool, pattern });
      C.deny(CREDS_DENIAL);
    }
  }

  if (tool === 'Bash' && typeof input.command === 'string') {
    for (const segment of segments(input.command)) {
      // A bare mention is not a read. `grep -rn GITLAB_TOKEN src/` is a
      // legitimate thing for a phase to do; it is the path that matters, and
      // only when the segment reads or writes it — by command or by redirect.
      // A throw here is logged and skips this segment only, so the credentials
      // pass below still runs.
      try {
        const verb = READER.test(segment) || WRITER.test(segment);
        for (const m of segment.matchAll(CANDIDATE)) {
          const before = segment.slice(0, m.index + m[0].length - m[1].length);
          if (!verb && !/[<>]\s*['"]?$/.test(before)) continue;
          const candidate = expand(m[1]);
          const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
          if (C.realish(resolved) === C.realish(ENV_FILE)) {
            C.event('denied_env_bash', { segment: segment.slice(0, 120) });
            C.deny(DENIAL);
          }
        }
      } catch (err) {
        C.logFailure('secret-guard (.env segment)', err);
      }
    }

    // The credentials, judged by name. Walked in order so that a `cd` moves
    // where every later relative path resolves: `cd <clone> && cat *.json`.
    // Each segment is judged on its own: one that throws is refused when a
    // credentials file is in reach of it, rather than reaching the catch at the
    // bottom and allowing every segment after it as well.
    let here = cwd;
    for (const raw of segments(input.command)) {
      const segment = raw.replace(/^[({]+\s*/, '').replace(/\s*\)+$/, '');
      try {
        const t = segment.replace(/["']/g, '').split(/\s+/).filter(Boolean);
        const vars = {};
        while (t.length && (/^[A-Za-z_]\w*=/.test(t[0]) || WRAPPERS.has(t[0]))) {
          const m = t.shift().match(/^([A-Za-z_]\w*)=(.*)$/);
          if (m) vars[m[1]] = m[2];
        }
        const argv0 = path.basename(t[0] || '');
        if (argv0 === 'cd' || argv0 === 'pushd') {
          const to = t.slice(1).find((a) => a === '-' || !a.startsWith('-'));
          if (to === undefined && argv0 === 'cd') here = HOME;
          else if (to && to !== '-') here = path.resolve(here, expand(to));
          continue;
        }
        if (INERT.has(argv0)) continue;
        if (pathWords(segment).some((w) => namesCreds(w, here))
          || searchReveals(argv0, t.slice(1), here)
          || (argv0 === 'git' && gitReveals(t.slice(1), vars, here))) {
          C.event('denied_cypress_creds', { tool, segment: segment.slice(0, 120) });
          C.deny(CREDS_DENIAL);
        }
      } catch (err) {
        C.logFailure('secret-guard (segment)', err);
        if (inReach(segment, here)) {
          C.event('denied_cypress_creds', { tool, segment: segment.slice(0, 120), failed: true });
          C.deny(CREDS_DENIAL);
        }
      }
    }
  }
} catch (err) {
  C.logFailure('secret-guard', err);
}

C.allow();
