#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: git policy on the Bash surface.
 *
 * v1 needed this hook to verify a review-approval label before allowing a
 * merge. Oneshot merges from the conductor in TypeScript, so no model holds a
 * merge tool and that half of the guard has nothing to guard. What remains is
 * the Bash surface inside the implement/verify phases, and it is stricter:
 *
 *   - no force-push, ever, to anything
 *   - no push to a protected branch. 'main' is in that list even though
 *     GitLab currently reports can_push=true for our token on project 1491 —
 *     the server would accept the push and it must still be refused
 *   - no push to any ref other than this run's leased branch
 *   - no deleting protected branches, local or remote
 *   - no `git remote set-url` (repointing origin defeats every other rule)
 *   - no `gh` / `glab` CLI, which are unguarded paths to the same operations
 *   - no git command whose working directory is outside the leased worktree.
 *     ~/Documents/erp is a live repo with a real remote on this machine; a
 *     `git commit -am` with the wrong cwd would land there
 *
 * `--no-verify` is deliberately ALLOWED: the husky pre-commit hook in these
 * repos is broken locally and aborts every commit. Lint is enforced as a phase
 * gate instead, which is where it can actually be reported.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

function projectCfg() {
  return C.loadConfig('project.json') || {
    branches: { protected: ['dev', 'stage', 'master', 'main'], prefix: 'oneshot' },
  };
}

/** Split a compound command into individually-checkable segments. */
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg) {
  // Good enough for policy: strip quotes, split on whitespace.
  return seg.replace(/["']/g, '').split(/\s+/).filter(Boolean);
}

function leasedBranch() { return process.env.ONESHOT_BRANCH || ''; }
function leasedWorktree() { return process.env.ONESHOT_WORKTREE || ''; }

function isProtected(ref, cfg) {
  const clean = String(ref || '').replace(/^\+/, '').replace(/^refs\/heads\//, '');
  const name = clean.includes(':') ? clean.split(':').pop() : clean;
  return (cfg.branches.protected || []).includes(name);
}

function checkPush(t, cfg) {
  const rest = t.slice(t.indexOf('push') + 1);

  if (rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease'))) {
    C.event('denied_force_push', { cmd: t.join(' ') });
    C.deny(
      'Denied: force-push. Nothing in Oneshot force-pushes, to any branch, ever. ' +
      'If history needs rewriting, stop and report it — a human decides that.',
    );
  }

  if (rest.includes('--delete') || rest.includes('-d')) {
    const target = rest.find((a) => !a.startsWith('-') && a !== 'origin');
    if (isProtected(target, cfg)) {
      C.event('denied_delete_protected', { target });
      C.deny(`Denied: '${target}' is a protected branch and cannot be deleted.`);
    }
  }

  const refs = rest.filter((a) => !a.startsWith('-') && a !== 'origin');
  const branch = leasedBranch();

  for (const ref of refs) {
    if (isProtected(ref, cfg)) {
      C.event('denied_push_protected', { ref });
      C.deny(
        `Denied: '${ref}' is a protected branch. Code reaches it only through a ` +
        'merge request, which the conductor opens and merges — not you. ' +
        `Push to your own branch (${branch || cfg.branches.prefix + '/ticket-...'}) instead.`,
      );
    }
    const bare = ref.includes(':') ? ref.split(':').pop() : ref;
    if (branch && bare && bare !== branch && !bare.startsWith('refs/tags/')) {
      C.event('denied_push_foreign', { ref, leased: branch });
      C.deny(
        `Denied: this run leased branch '${branch}' and may push only to it. ` +
        `You tried to push '${ref}'.`,
      );
    }
  }

  // A bare `git push` with no refspec pushes the current branch. That is fine
  // when cwd is the leased worktree — which the cwd check below guarantees.
}

function checkBranchDelete(t, cfg) {
  const del = t.some((a) => a === '-D' || a === '-d' || a === '--delete');
  if (!del) return;
  const target = t.slice(t.indexOf('branch') + 1).find((a) => !a.startsWith('-'));
  if (isProtected(target, cfg)) {
    C.event('denied_branch_delete', { target });
    C.deny(`Denied: '${target}' is a protected branch and cannot be deleted.`);
  }
}

function checkCwd(cmd) {
  const wt = leasedWorktree();
  if (!wt) return;

  // An explicit `cd <path>` or `git -C <path>` moves the effective directory.
  const explicit = [];
  for (const seg of segments(cmd)) {
    const t = tokens(seg);
    if (t[0] === 'cd' && t[1]) explicit.push(t[1]);
    const ci = t.indexOf('-C');
    if (t[0] === 'git' && ci !== -1 && t[ci + 1]) explicit.push(t[ci + 1]);
  }

  for (const raw of explicit) {
    if (raw.startsWith('-')) continue;
    // Expand ~ and $HOME BEFORE resolving. Without this, `cd ~/Documents/erp`
    // is a relative path that joins onto the worktree and lands "inside" it —
    // the guard then waves through a commit into the context repo.
    const target = C.expandTilde(raw.replace(/^\$HOME|^\$\{HOME\}/, C.HOME));
    const abs = path.isAbsolute(target) ? target : path.join(wt, target);
    if (!C.isInside(abs, wt) && !C.isInside(abs, path.join(C.ONESHOT, 'state'))) {
      C.event('denied_cwd', { target: abs, worktree: wt });
      C.deny(
        `Denied: '${target}' is outside this run's worktree (${wt}). ` +
        'Other repositories on this machine — including the read-only context ' +
        'repo — are live checkouts with real remotes. Stay in your worktree.',
      );
    }
  }
}

try {
  const data = C.readInput();
  const cmd = (data.tool_input || {}).command || '';
  if (cmd) {
    const cfg = projectCfg();
    checkCwd(cmd);

    for (const seg of segments(cmd)) {
      const t = tokens(seg);
      if (!t.length) continue;

      if (t[0] === 'gh' || t[0] === 'glab') {
        C.event('denied_forge_cli', { cmd: seg });
        C.deny(
          `Denied: the '${t[0]}' CLI is an unguarded path to pushes, merges and ` +
          'releases. Use the GitLab MCP tools, which are guarded, or leave the ' +
          'operation to the conductor.',
        );
      }

      if (t[0] !== 'git') continue;
      const sub = t.find((a, i) => i > 0 && !a.startsWith('-') && t[i - 1] !== '-C');

      if (sub === 'push') checkPush(t, cfg);
      if (sub === 'branch') checkBranchDelete(t, cfg);

      if (sub === 'remote' && t.includes('set-url')) {
        C.event('denied_remote_seturl', { cmd: seg });
        C.deny('Denied: `git remote set-url` repoints origin and defeats every other guard.');
      }

      if (sub === 'reset' && t.includes('--hard')) {
        const target = t[t.indexOf('--hard') + 1] || '';
        if (isProtected(target.replace(/^origin\//, ''), cfg)) {
          C.event('denied_reset_hard', { target });
          C.deny(`Denied: \`git reset --hard ${target}\` would discard this run's work.`);
        }
      }
    }
  }
} catch (err) {
  C.logFailure('git-guard', err);
}

C.allow();
