#!/usr/bin/env node
'use strict';
/**
 * PostToolUse: ESLint, on every frontend/ .js/.jsx write.
 *
 * WHY THIS IS A HOOK. `IMPLEMENT_SCHEMA` requires every implement phase to
 * attest `lintClean: 'flake8 + pylint + eslint all pass.'`, and the field is in
 * the schema's required list — so the pipeline retries the phase until it swears
 * to it. `py-lint.cjs` makes the flake8 and pylint halves real. Nothing anywhere
 * ran eslint: no hook mentioned it, and the app repo's `.gitlab-ci.yml`
 * `run_lint` job runs pylint only. The pipeline was asking a phase to swear to a
 * linter nobody runs, which is worse than not asking — an attestation that
 * cannot be false teaches a session that attestations need not be true.
 *
 * Two things downstream depended on it and were quietly broken:
 *   - `dead-code-sweep` makes "eslint no-unused-vars output" its frontend source
 *     of truth, for a tool no phase was required to run.
 *   - `erp-code-review`'s severity rules tell reviewers not to flag what
 *     "ESLint / Prettier already catch — trust CI". For the frontend that was
 *     false. This hook is what makes that sentence true.
 *
 * ⚠️ THE NODE_ENV TRAP, and why it is set here rather than assumed. The app's
 * config parses through `babel-preset-react-app`, which HARD FAILS with
 * "requires that you specify NODE_ENV or BABEL_ENV" when neither is set. A
 * phase session does not carry NODE_ENV. Measured: without it EVERY file comes
 * back as a single fatal parse error, so a naive version of this hook either
 * blocks every frontend write, or — if a fatal is read as "could not run, fail
 * open" — silently checks nothing, forever, while reporting a pass. With
 * NODE_ENV=development a clean file is 0 errors, 0 warnings. So this hook sets
 * it, and a fatal that still mentions NODE_ENV/BABEL_ENV is treated as the
 * environment fault it is (logged, fail open) while ANY OTHER fatal is reported
 * — a file the session just wrote that no longer parses is the most useful
 * thing this guard can say.
 *
 * ONLY THE LINES THIS WRITE ADDED ARE JUDGED. Non-negotiable: the frontend
 * carries 1088 inline comments and 457 `eslint-disable`s, so judging whole
 * files would block a one-line edit until the phase refactored code the ticket
 * never touched. A fatal is the one exception — a file that does not parse has
 * no trustworthy line numbers to scope by.
 *
 * ERRORS ONLY, NOT WARNINGS. The repo deliberately set `sonarjs/*`,
 * `no-debugger`, `react/prefer-es6-class` and `jsx-filename-extension` to warn;
 * blocking on them would overrule a choice the repo made on purpose. Same
 * reason nothing here re-adds `no-console`, `react/no-array-index-key` or
 * `react/no-danger`, which `.eslintrc` sets to 0: the config is the source of
 * truth, and this hook runs it rather than restating it.
 *
 * Fails OPEN when the binary or the config is missing — eslint lives in the
 * seed checkout the worktree's `node_modules` symlinks to, and is absent from a
 * bare context repo. Fail-open is also why this is worth saying out loud: a
 * guard that silently stops running looks exactly like a guard that passes.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Just under the conductor's 60s GUARD_TIMEOUT_MS, so eslint is what gets killed and it is logged. */
const TOOL_TIMEOUT_MS = 55_000;
const MAX_LINES = 25;

/** Config filenames ESLint v7 discovers, in its own precedence order. */
const CONFIG_FILES = [
  '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml',
  '.eslintrc.json', '.eslintrc',
];

/**
 * A fatal that means "the toolchain is misconfigured", not "your file is
 * broken". Narrow on purpose: everything else fatal is the session's own syntax.
 */
const ENV_FATAL = /NODE_ENV|BABEL_ENV|babel-preset|Cannot find module|Failed to load/i;

/** eslint is in the seed checkout the worktree's node_modules symlinks to, never on PATH. */
function eslintBin(worktree) {
  const local = path.join(worktree, 'node_modules', '.bin', 'eslint');
  return fs.existsSync(local) ? local : '';
}

function configIn(worktree) {
  return CONFIG_FILES.find((name) => fs.existsSync(path.join(worktree, name))) || '';
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/**
 * The line numbers this write added to `src`, or null for "every line".
 *
 * A third copy of `js-standards.cjs`'s version, deliberately: `_common.cjs` does
 * not export it, and lifting it out would mean editing two already-merged
 * guards and their tests inside a PR whose subject is eslint. The duplication is
 * the cheaper mistake, and it is now the strongest argument for making the
 * extraction its own change.
 *
 * An Edit's new_string is located in the file as written; with several
 * occurrences and no replace_all we cannot tell which was edited, so all count.
 * A Write is diffed against HEAD as a multiset, so a moved line is not "added";
 * an untracked file, or any git failure, is new.
 */
function addedLines(src, input, tool, target) {
  if (tool === 'Edit') {
    const added = new Set();
    const text = input.new_string || '';
    if (!text) return added;
    const span = text.split('\n').length - 1;
    for (let at = src.indexOf(text); at !== -1; at = src.indexOf(text, at + text.length)) {
      const first = lineOf(src, at);
      for (let l = first; l <= first + span; l += 1) added.add(l);
    }
    return added;
  }
  const head = spawnSync('git', ['show', `HEAD:./${path.basename(target)}`], {
    cwd: path.dirname(target), encoding: 'utf8', timeout: 10_000,
  });
  if (head.status !== 0) return null;
  const before = new Map();
  for (const line of head.stdout.split('\n')) before.set(line, (before.get(line) || 0) + 1);
  const added = new Set();
  src.split('\n').forEach((line, i) => {
    const left = before.get(line) || 0;
    if (left) before.set(line, left - 1); else added.add(i + 1);
  });
  return added;
}

/**
 * Run eslint and return its message list, or null when it could not produce a
 * verdict.
 *
 * NODE_ENV is forced because the parser demands it (see the header). An existing
 * value is respected: a phase that set `test` or `production` meant it, and all
 * three are valid to the preset.
 */
function runEslint(bin, target, worktree) {
  const res = spawnSync(bin, ['--format', 'json', '--no-color', target], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: 8 << 20,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  });

  if (res.error) return { failed: `eslint did not run: ${res.error.message}` };
  if (res.signal) return { failed: `eslint killed by ${res.signal} after ${TOOL_TIMEOUT_MS}ms` };
  // 0 = clean, 1 = findings (fatal parse errors included). 2 = eslint's own
  // usage/config error, which says nothing about the file.
  if (res.status !== 0 && res.status !== 1) {
    return { failed: `eslint exited ${res.status}: ${String(res.stderr || '').trim().slice(0, 400)}` };
  }
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    const first = Array.isArray(parsed) ? parsed[0] : null;
    return { messages: (first && first.messages) || [] };
  } catch {
    return { failed: `eslint emitted non-JSON: ${String(res.stdout || '').trim().slice(0, 200)}` };
  }
}

function trim(lines) {
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return `${lines.slice(0, MAX_LINES).join('\n')}\n… and ${lines.length - MAX_LINES} more`;
}

try {
  const data = C.readInput();
  const response = data.tool_response || {};
  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path || input.path || '';
  const worktree = process.env.ONESHOT_WORKTREE || '';

  const relevant = WRITE_TOOLS.has(data.tool_name || '')
    && response.success !== false
    && /(^|\/)frontend\/.*\.jsx?$/.test(target)
    && worktree && C.isInside(target, worktree)
    && fs.existsSync(target);

  if (relevant) {
    const bin = eslintBin(worktree);
    const config = configIn(worktree);
    if (!bin) {
      C.logFailure('eslint-guard', `${target}: no eslint in ${worktree}/node_modules/.bin`);
    } else if (!config) {
      C.logFailure('eslint-guard', `${target}: no eslint config at the root of ${worktree}`);
    } else {
      const result = runEslint(bin, target, worktree);
      if (result.failed) {
        C.logFailure('eslint-guard', `${target}: ${result.failed}`);
      } else {
        const envFatal = result.messages.find((m) => m.fatal && ENV_FATAL.test(m.message || ''));
        if (envFatal) {
          // The trap. Never reported as a finding in the file: the file is fine
          // and the toolchain is not, and a session cannot fix this one.
          C.logFailure('eslint-guard', `${target}: toolchain fault: ${envFatal.message}`);
        } else {
          const src = fs.readFileSync(target, 'utf8');
          const added = addedLines(src, input, data.tool_name, target);
          const problems = result.messages
            // A fatal is always reported: a file that no longer parses has no
            // line numbers worth scoping by. Warnings never are — the repo set
            // them to warn on purpose.
            .filter((m) => m.fatal || (m.severity === 2
              && (!added || added.has(m.line))))
            .map((m) => `  ${m.fatal ? 'parse error' : `line ${m.line}`}`
              + `${m.column ? `:${m.column}` : ''} ${m.ruleId || ''}  ${m.message}`.trimEnd());

          if (problems.length) {
            C.event('eslint_block', { target, count: problems.length });
            C.postBlock(
              `${target} does not pass eslint on the lines this write added:\n\n${
                trim(problems)}\n\n`
              + 'Fix these now, in this file. Zero errors is the bar, and `lintClean` in your '
              + 'handoff is an attestation that this passed — it is checked. Only the lines you '
              + 'added are judged, so legacy findings elsewhere in the file are not yours to fix '
              + 'and will not be reported. Run it yourself with '
              + '`NODE_ENV=development node_modules/.bin/eslint <file>` — without NODE_ENV the '
              + 'parser fails on every file. An `eslint-disable` needs a human to affirm it, so '
              + 'report it rather than adding one.',
            );
          }
        }
      }
    }
  }
} catch (err) {
  C.logFailure('eslint-guard', err);
}

C.allow();
