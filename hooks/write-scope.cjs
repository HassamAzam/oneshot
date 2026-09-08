#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: per-phase filesystem write scopes.
 *
 * Intercepts Write / Edit / NotebookEdit.
 *
 * Two absolute denials apply to EVERY phase, with no exceptions:
 *
 *   1. The Oneshot runtime itself (hooks/, config/, src/, scripts/, harness/,
 *      skills/, ~/.claude/). A phase must never be able to edit the constraints
 *      on it. harness/ and skills/ matter more than they look: each worktree
 *      has .claude/* SYMLINKED into them so phases can use the real skills,
 *      which means a naive prefix check would accept
 *      <worktree>/.claude/skills/x/SKILL.md as "inside the worktree" while the
 *      write lands here — letting an implement phase rewrite the skills that
 *      govern it, permanently, for every future run and every interactive
 *      session. C.isInside() realpath-resolves before comparing. See
 *      docs/HOOKS.md 4.1.
 *
 *   2. The context repo (~/Documents/erp). Read-only reference for prior art,
 *      and a live clone with a real remote — never written to.
 *
 * A phase that arrives with NO scopes is refused rather than waved through.
 * Empty means the conductor's scope expansion produced nothing — a
 * configuration slip — and the one thing a configuration slip must not do is
 * silently upgrade a phase to unrestricted writes. Sessions without
 * ONESHOT_PHASE never get here at all: the gate above exits first, so an
 * ordinary interactive session on this machine is untouched.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const RUNTIME_DENY = [
  path.join(C.ONESHOT, 'hooks'),
  path.join(C.ONESHOT, 'config'),
  path.join(C.ONESHOT, 'src'),
  path.join(C.ONESHOT, 'scripts'),
  // The skills, agents and rules every phase runs under. Worktrees reach them
  // through <worktree>/.claude/* symlinks, which C.isInside() realpath-resolves
  // to here — so without this entry an implement phase could rewrite the skill
  // that governs it, for every future run.
  path.join(C.ONESHOT, 'harness'),
  path.join(C.ONESHOT, 'skills'),
  path.join(C.ONESHOT, 'package.json'),
  path.join(C.HOME, '.claude'),
];

function contextRepo() {
  const fromEnv = process.env.CONTEXT_REPO || C.envFile('CONTEXT_REPO');
  return C.expandTilde(fromEnv || path.join(C.HOME, 'Documents', 'erp'));
}

/**
 * Scopes are handed in by the conductor rather than derived here, so the
 * allowlist for a phase lives in config/phases.json next to everything else
 * about that phase instead of being duplicated in a hook table.
 */
function allowedScopes() {
  return (process.env.ONESHOT_WRITE_SCOPES || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

function targetPath(data) {
  const i = data.tool_input || {};
  return i.file_path || i.notebook_path || i.path || '';
}

try {
  const data = C.readInput();
  const target = targetPath(data);

  if (target) {
    for (const denied of RUNTIME_DENY) {
      if (C.isInside(target, denied)) {
        C.event('denied_write_runtime', { target, denied });
        C.deny(
          `Denied: ${target} is part of the Oneshot runtime. No phase may edit the ` +
          'hooks, config, source, or skills that constrain it. If you reached it ' +
          'through <worktree>/.claude/, note that .claude/* are symlinks into the ' +
          'Oneshot harness. If a rule here is wrong, say so in your final summary — ' +
          'a human changes it, not you.',
        );
      }
    }

    const ctx = contextRepo();
    if (C.isInside(target, ctx)) {
      C.event('denied_write_context', { target, contextRepo: ctx });
      C.deny(
        `Denied: ${target} resolves inside the read-only context repo (${ctx}). ` +
        'That repo is reference material — it is never written to. Write to your ' +
        'worktree instead.',
      );
    }

    const scopes = allowedScopes();
    if (!scopes.length) {
      C.event('denied_write_no_scopes', { target });
      C.deny(
        `Denied: the '${C.phase()}' phase was handed no write scopes at all, so every path is ` +
        'outside them. This is a configuration fault, not something you can work around — ' +
        'report it in `blocked` and stop.',
      );
    }

    if (!scopes.some((s) => C.isInside(target, s))) {
      C.event('denied_write_scope', { target, scopes });
      C.deny(
        `Denied: the '${C.phase()}' phase may only write under:\n` +
        scopes.map((s) => `  - ${s}`).join('\n') +
        `\nYou tried to write ${target}. Put the file in one of those locations.`,
      );
    }
  }
} catch (err) {
  C.logFailure('write-scope', err);
}

C.allow();
