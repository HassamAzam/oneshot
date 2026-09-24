#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: refuse to author a frontend unit test.
 *
 * Intercepts Write / Edit / NotebookEdit.
 *
 * The app repos' Jest harness has rotted — Babel drift, a missing enzyme
 * adapter, ESM transform gaps — and CI never runs it: .gitlab-ci.yml installs
 * and builds the frontend and never invokes the runner. A case built on it is
 * therefore unpassable by construction, and one such case failed identically on
 * three separate laps before anyone noticed the runner was the problem rather
 * than the code. `testcases` and `verify` already say so in their prompts and
 * `plan` is getting the same line, but all of that is ADVICE — and `implement`,
 * the phase that actually writes files, carries none of it. This hook is the
 * part that cannot be talked out of.
 *
 * WHAT IT MATCHES, AND WHY EXACTLY THAT SET. The rule is not a guess about
 * filenames; it is the app repo's own Jest config, copied. Both targets
 * (arbisoft/workstreamai and arbisoft/erp) configure, in package.json:
 *
 *     roots:     [ <rootDir>/frontend/src ]
 *     testMatch: [ <rootDir>/frontend/src/ ...any... /__tests__/ ...any... /
 *                    <name>.{js,jsx,ts,tsx}
 *                  <rootDir>/frontend/src/ ...any... /
 *                    <name>.{spec,test}.{js,jsx,ts,tsx} ]
 *
 * Neither repo overrides that at the runner (frontend/scripts/test.js is the
 * stock ejected CRA runner and adds no patterns), and neither defines a second
 * Jest project. So a path this guard denies is precisely a path Jest would
 * collect, and a path outside frontend/src is one Jest cannot see however it is
 * named. Denying more than Jest collects would buy nothing and cost the
 * carve-out below; denying less would leave open the hole this exists to close.
 *
 * THE PLAYWRIGHT CARVE-OUT — the reason the rule is anchored on a DIRECTORY and
 * not on `.spec.` / `.test.` alone. Playwright is the SANCTIONED route:
 * `verify` and `ui-evidence` drive the real browser with it and write scripts
 * to do so, so a matcher keyed on the filename would deny the one frontend
 * testing route that is allowed and break `verify` on every UI ticket. It needs
 * no carve-out by name, because it is already elsewhere on disk by
 * construction:
 *
 *   - the harness's Playwright driver lives in the Oneshot repo, under
 *     skills/local-browser-verify/scripts/ — never in a worktree
 *   - everything that driver writes goes to state/runs/<iid>/harness/
 *   - a session's hand-written driver goes to <worktree>/.verify-scratch/
 *   - neither app repo has a playwright dependency, a playwright.config, an
 *     e2e/ directory or one committed spec — Playwright resolves from Oneshot's
 *     own install, which is why it is not in the worktree's node_modules
 *
 * None of those sit under frontend/src, so none are reachable by this rule. A
 * future Playwright home at the app repo's root stays reachable too: it would
 * be outside Jest's `roots`, which is the same line this guard draws. If a
 * Playwright script ever does need to live under frontend/src, it is this
 * comment that is wrong, not the script.
 *
 * Deliberately NOT denied: backend Python tests (sanctioned — see
 * context/rules/testing.md, and CI does run them); Oneshot's own unit tests,
 * which cannot collide because this repo has no frontend/ directory at all; and
 * every read, grep or glob of a test file — this guards WRITES only. Deleting a
 * stale test is a Bash `rm` and never reaches here, which is the deliberate
 * escape valve for a test your change made obsolete.
 *
 * Fails OPEN, like every guard outside the FAIL_CLOSED set in
 * src/conductor/hooks.ts. Writing a doomed test wastes part of a lap; a guard
 * that wedges the phase costs the whole run.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

/** Jest's `roots`, as path segments. Nothing outside this is ever collected. */
const JEST_ROOT = ['frontend', 'src'];

/** The extension set shared by both `testMatch` patterns. */
const COLLECTED_EXT = /\.(js|jsx|ts|tsx)$/;

/** The second `testMatch` pattern: a `.spec.` / `.test.` infix before it. */
const TEST_SUFFIX = /\.(spec|test)\.(js|jsx|ts|tsx)$/;

/** The first `testMatch` pattern: any collected file below this directory. */
const TEST_DIR = '__tests__';

/**
 * The tools that author a file.
 *
 * src/conductor/hooks.ts already registers this guard behind the same matcher,
 * so in the pipeline nothing else arrives. It is re-checked here because the
 * promise in the header — that reading and searching a test is untouched — has
 * to hold for the script itself, not only for one call site that is currently
 * configured correctly.
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function targetPath(data) {
  if (!WRITE_TOOLS.has(data.tool_name)) return '';
  const i = data.tool_input || {};
  return i.file_path || i.notebook_path || i.path || '';
}

/**
 * The segments of `target` that sit below Jest's `roots`, or null when the path
 * is outside it.
 *
 * Resolved with realish() before matching, for the same reason write-scope
 * does it: each worktree's .claude is composed from symlinks, and a path that
 * traverses one is not the path it appears to be.
 */
function belowJestRoot(target) {
  const parts = C.realish(target).split(path.sep).filter(Boolean);
  for (let i = 0; i + JEST_ROOT.length <= parts.length; i += 1) {
    if (JEST_ROOT.every((seg, k) => parts[i + k] === seg)) {
      return parts.slice(i + JEST_ROOT.length);
    }
  }
  return null;
}

/** Why Jest would collect this path, or '' when it would not. */
function collectedBy(target) {
  const below = belowJestRoot(target);
  if (!below || below.length === 0) return '';

  const file = below[below.length - 1];
  if (!COLLECTED_EXT.test(file)) return '';

  if (below.slice(0, -1).includes(TEST_DIR)) return `it sits under a ${TEST_DIR}/ directory`;
  if (TEST_SUFFIX.test(file)) return 'its name carries a .test. or .spec. suffix';
  return '';
}

try {
  const data = C.readInput();
  const target = targetPath(data);
  const why = target ? collectedBy(target) : '';

  if (why) {
    C.event('denied_frontend_test', { target, why });
    C.deny(
      `Denied: ${target} is a frontend unit test. This repo's Jest \`testMatch\` ` +
      `collects it because ${why}, under frontend/src.\n\n` +
      'Do not write it, and do not repair the runner to make it pass. The Jest ' +
      'toolchain here has rotted — Babel drift, a missing enzyme adapter, ESM ' +
      'transform gaps — and CI never runs it, so the test is unpassable by ' +
      'construction and proves nothing about your change either way. One such case ' +
      'failed identically on three separate laps. An hour spent reviving Jest is an ' +
      'hour not spent on the ticket.\n\n' +
      'Frontend behaviour is covered instead by the Playwright cases `testcases` ' +
      'writes and `verify` executes against the real running app. That is where this ' +
      'coverage belongs — as a case, not as a file here. Backend Python tests are ' +
      'unaffected and remain the right home for backend logic.\n\n' +
      'If this file is only stale because your change renamed or removed what it ' +
      'tested, say so in your summary and leave it alone: a human decides whether a ' +
      'dead Jest test is deleted.',
    );
  }
} catch (err) {
  C.logFailure('frontend-test-guard', err);
}

C.allow();
