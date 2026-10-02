#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: no package installs, no venv rebuilds, on the Bash surface.
 *
 * WHY THIS IS A HOOK, AND WHY IT DENIES RATHER THAN WARNS. A worktree's
 * `node_modules` is a SYMLINK into one shared seed checkout — all of
 * `oneshot-wt/app-80{10,11,12}/node_modules` point at the same real directory.
 * An `npm ci` there does not corrupt the run that typed it; it rewrites the
 * tree that every concurrent run and the developer's own checkout are reading
 * from, mid-flight. That is the same class of harm `write-scope`'s `$ERP_REPO`
 * deny exists for, and it is the widest blast radius on the Bash surface.
 *
 * The rule was already stated absolutely in five places — `prompts.ts` for
 * `implement` and `ui-evidence`, and the `local-browser-verify`,
 * `bug-reproduction` and `ship-ticket` skills — and enforced in none. Prose is
 * advice: a phase whose `require('playwright')` throws MODULE_NOT_FOUND is a
 * phase under pressure, holding a tool that looks exactly like the fix, with
 * the rule several thousand tokens up its context. `harness.cjs` predicted
 * this failure in a comment long before this hook existed.
 *
 * PreToolUse, not Post: the damage is done the moment npm resolves and writes.
 * There is nothing for a PostToolUse block to undo.
 *
 * SCOPE: everywhere, not only inside ONESHOT_WORKTREE. Three reasons. A
 * conductor-cwd phase installing into Oneshot's own `node_modules` is just as
 * wrong as a worktree phase doing it. A cwd gate is trivially stepped around by
 * `npm --prefix <seed path> ci`, which reaches the shared tree without ever
 * leaving the worktree. And no phase in this pipeline has a legitimate reason
 * to install anything: every dependency is installed by an operator, before a
 * run starts, which is why hooks themselves must work before `npm install`.
 *
 * `npx` IS denied. Nothing in any prompt, skill, agent doc or phase config ever
 * tells a session to run it; Playwright is reached three other ways (NODE_PATH
 * from `phase.ts`, "resolve through the node_modules your worktree already has"
 * in `prompts.ts`, and a structural `require.resolve` in `harness.cjs`); and
 * `README.md` already states the rule outright — nothing in this pipeline may
 * shell out to npx at run time, because it re-resolves against the registry on
 * every spawn and hangs behind the VPN. `npm run deps:verify` does spawn npx,
 * but that is an operator preflight: a hook sees only the Bash string, and
 * `npm run` stays allowed.
 *
 * `rm -rf node_modules` and `rm -rf venv` are denied too. They are the same
 * failure arriving from the other direction — the usual shape is `rm -rf
 * node_modules && npm ci`, and denying only the second half would be theatre
 * (a PreToolUse deny does stop the whole compound command, but not a bare `rm`).
 *
 * DELIBERATELY NOT COVERED. `npm init` (it writes package.json; it does not
 * touch the shared tree, and that is a different rule). `uv`, which is not
 * installed on this machine. Any interpreter that installs through its own API
 * — `python -c "import pip._internal..."`, a Node script calling npm — the
 * same best-effort boundary `secret-guard` documents. A guard on the Bash
 * surface raises the cost of the wrong reflex; it is not a sandbox.
 *
 * Fails OPEN, like every guard here: a bug in this file must never wedge a
 * phase that was about to run its tests.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

/**
 * Split a compound command into individually-checkable segments.
 *
 * Beyond `git-guard`'s separators this also splits on `$(` and on a backtick,
 * because a command substitution RUNS what is inside it: `echo $(npm install)`
 * installs, and without the split its program position is `echo`. Splitting on
 * `$(` rather than on a bare `(` is what distinguishes it from the quoted
 * `echo "(npm ci) is denied"`, which must stay allowed — after quote-stripping
 * those two are otherwise the same token stream.
 */
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|\||\$\(|`/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Split on whitespace, then strip quotes and shell grouping from each token.
 * `(cd frontend; npm ci)` is the form that matters: `segments()` leaves `npm ci)`,
 * whose subcommand token is `ci)` and is in no denylist.
 *
 * Stripping INSIDE tokens rather than splitting the segment on a bare bracket is
 * what keeps the false-positive surface at zero: `echo "(npm ci) is denied"` still
 * has `echo` in the program position, and every check below fires on that position
 * only. Splitting on `(` would have turned that echo into a deny.
 */
function tokens(seg) {
  return String(seg)
    .split(/\s+/)
    .map((t) => t.replace(/["'(){}]/g, ''))
    .filter(Boolean);
}

/**
 * Drop what stands between the start of a segment and the command being run.
 * `NODE_ENV=development npm ci` is a realistic shape — the eslint trap in this
 * repo teaches sessions to prefix NODE_ENV — and its first token is neither a
 * flag nor the command. Without this, every check below reads the assignment as
 * the program name and the segment sails through. `bash -c "npm ci"` is the same
 * problem wearing an interpreter: the program position is `bash`.
 */
const WRAPPERS = ['sudo', 'env', 'command', 'time', 'nohup', 'exec'];

function program(t) {
  let i = 0;
  while (i < t.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) { i += 1; continue; }
    if (WRAPPERS.includes(t[i])) { i += 1; continue; }
    if (/^(ba|z|k|da)?sh$/.test(t[i]) && t[i + 1] === '-c') { i += 2; continue; }
    break;
  }
  return t.slice(i);
}

const NODE_PMS = new Set(['npm', 'yarn', 'pnpm']);

/**
 * Subcommands that write into the shared tree. Includes npm's short aliases for
 * install (`i`, `in`, `ins`, `inst`, `it`, `cit`) because they are one keystroke
 * from the long form, and `exec`/`dlx`, which fetch a package to run it. npm's
 * typo aliases (`isntall`, `instal`, …) are not enumerated: a model does not
 * typo, and a denylist that chases them reads as paranoia rather than policy.
 */
const PM_WRITES = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'it', 'cit',
  'clean-install', 'install-ci-test', 'install-test',
  'ci', 'add', 'update', 'up', 'upgrade', 'rebuild',
  'link', 'unlink', 'dedupe', 'prune', 'exec', 'dlx', 'create',
]);

/**
 * Read-only subcommands. The FIRST of these that appears ends the scan, which
 * is what keeps `npm run install-check` and `npm test -- --grep add` allowed:
 * everything after `run` or `test` is a script name or an argument, never a
 * subcommand, and must not be read as one.
 */
const PM_READS = new Set([
  'run', 'run-script', 'test', 'start', 'ls', 'list', 'll', 'why',
  'view', 'info', 'outdated', 'audit', 'config', 'version', 'help',
  'bin', 'root', 'prefix', 'explain', 'doctor',
]);

/**
 * npm/yarn/pnpm. Scans left to right for the subcommand rather than reading
 * `t[1]`, because a value-taking flag sits between them in exactly the command
 * that does the most damage: `npm --prefix <seed> ci` reaches the shared
 * checkout directly, and its `t[1]` is `--prefix`.
 */
function checkNodePm(t, seg) {
  if (!NODE_PMS.has(t[0])) return;

  let sub = '';
  for (let i = 1; i < t.length; i += 1) {
    const tok = t[i];
    if (tok === '--') break;
    if (tok.startsWith('-')) continue;
    if (PM_READS.has(tok)) return;
    if (PM_WRITES.has(tok)) { sub = tok; break; }
    // An unknown token is a flag's value or a path. Keep scanning.
  }

  // Bare `yarn` IS `yarn install`. Bare `npm` and `pnpm` only print help.
  if (!sub && t[0] === 'yarn') sub = '(bare yarn installs)';
  if (!sub) return;

  C.event('denied_install', { cmd: seg, tool: t[0], sub });
  C.deny(
    `Denied: \`${t[0]} ${sub}\`. A worktree's node_modules is a symlink into one shared ` +
    'seed checkout, so an install does not rewrite this run\'s dependencies — it rewrites ' +
    'the dependencies of every other run on this machine, and of the developer\'s own ' +
    'checkout, while they are reading from them. Every dependency this pipeline needs is ' +
    'already installed. Resolve a module through the node_modules your worktree has and ' +
    'through NODE_PATH (Playwright lives in the Oneshot install, not the worktree). If it ' +
    'genuinely is not there, that is an environment fault worth reporting as blocked — not ' +
    'something to fix by installing into the shared tree. ' +
    `\`${t[0]} test\`, \`${t[0]} start\`, \`${t[0]} run <script>\` and \`${t[0]} ls\` are allowed.`,
  );
}

/** npx fetches and runs. Covered separately: it has no subcommand to scan for. */
function checkNpx(t, seg) {
  if (t[0] !== 'npx') return;
  C.event('denied_install', { cmd: seg, tool: 'npx' });
  C.deny(
    'Denied: `npx` resolves against the npm registry on every spawn, writes what it ' +
    'fetches into the shared node_modules, and hangs behind the VPN — it has wedged a ' +
    'phase before its first turn twice in this project\'s history, once as an MCP command ' +
    'and once as a statusLine. Nothing in this pipeline may shell out to npx at run time. ' +
    'Run the local binary from node_modules/.bin, or `require` the module through ' +
    'NODE_PATH.',
  );
}

const PIP_WRITES = new Set(['install', 'uninstall']);

/**
 * pip, directly or as `python -m pip`. The venv is seeded once per worktree by
 * the conductor; a phase that installs into it changes what every later phase
 * of the same run imports, and the run's test results stop describing the
 * branch under test.
 */
function checkPip(t, seg) {
  let rest = null;
  if (/^pip3?$/.test(t[0])) {
    rest = t.slice(1);
  } else if (/^python3?(\.\d+)?$/.test(t[0])) {
    const m = t.indexOf('-m');
    if (m !== -1 && t[m + 1] === 'pip') rest = t.slice(m + 2);
  }
  if (!rest) return;

  const sub = rest.find((tok) => !tok.startsWith('-'));
  if (!sub || !PIP_WRITES.has(sub)) return;

  C.event('denied_install', { cmd: seg, tool: 'pip', sub });
  C.deny(
    `Denied: \`pip ${sub}\` mutates the worktree's venv, which later phases of this run ` +
    'import from — the test results would stop describing the branch under test. The venv ' +
    'is seeded before the run starts. A missing package is an environment fault worth ' +
    'reporting as blocked. `pip list`, `pip show` and `pip freeze` are allowed.',
  );
}

/** A rebuilt venv is a venv without the repo's own requirements in it. */
function checkVenv(t, seg) {
  let hit = '';
  if (t[0] === 'virtualenv') {
    hit = 'virtualenv';
  } else if (/^python3?(\.\d+)?$/.test(t[0])) {
    const m = t.indexOf('-m');
    if (m !== -1 && ['venv', 'virtualenv'].includes(t[m + 1])) hit = `python -m ${t[m + 1]}`;
  }
  if (!hit) return;

  C.event('denied_install', { cmd: seg, tool: 'venv' });
  C.deny(
    `Denied: \`${hit}\` would replace the worktree's venv with an empty one — no flake8, ` +
    'no pylint, none of the repo\'s requirements — and the phase gate would then fail for ' +
    'a reason that has nothing to do with the code. The venv is seeded before the run ' +
    'starts. If it is broken, report blocked.',
  );
}

const SHARED_TREES = new Set(['node_modules', 'venv']);

/**
 * `rm -rf node_modules` is the other half of the same mistake. Matches any path
 * COMPONENT, so deleting inside the tree counts, and so a path that merely
 * starts with the name (`venv-report.txt`) does not.
 */
function checkRemoveSharedTree(t, seg) {
  if (t[0] !== 'rm') return;
  for (const tok of t.slice(1)) {
    if (tok.startsWith('-')) continue;
    const parts = tok.split('/').filter(Boolean);
    if (!parts.some((p) => SHARED_TREES.has(p))) continue;

    C.event('denied_install', { cmd: seg, tool: 'rm', target: tok });
    C.deny(
      `Denied: \`rm\` of '${tok}'. The worktree's node_modules is a symlink into a shared ` +
      'seed checkout and its venv is what this run\'s linters live in; deleting either ' +
      'breaks every concurrent run, and the install that would follow is denied too, so ' +
      'the tree would stay broken. If dependencies look wrong, report blocked rather than ' +
      'rebuilding.',
    );
  }
}

try {
  const data = C.readInput();
  const cmd = (data.tool_input || {}).command || '';
  if (cmd) {
    for (const seg of segments(cmd)) {
      const t = program(tokens(seg));
      if (!t.length) continue;

      checkNodePm(t, seg);
      checkNpx(t, seg);
      checkPip(t, seg);
      checkVenv(t, seg);
      checkRemoveSharedTree(t, seg);
    }
  }
} catch (err) {
  C.logFailure('install-guard', err);
}

C.allow();
