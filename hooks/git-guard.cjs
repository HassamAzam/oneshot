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
 *   - no push to a protected branch. 'main' is in that list whatever GitLab
 *     reports for our token — on a project where it is unprotected or says
 *     can_push=true, the server would accept the push and it must still be refused
 *   - no push to any ref other than this run's leased branch
 *   - no deleting protected branches, local or remote
 *   - no `git remote set-url` (repointing origin defeats every other rule)
 *   - no `gh` / `glab` CLI, which are unguarded paths to the same operations
 *   - no git command whose working directory is outside the leased worktree.
 *     ~/Documents/erp is a live repo with a real remote on this machine; a
 *     `git commit -am` with the wrong cwd would land there
 *   - no push at all under DRY_RUN. The dry-run banner promises that every
 *     write is refused, and the SDK's own tool policy cannot make that true on
 *     the Bash surface: a push is just a command there
 *   - no mutating git from a conductor-cwd phase. Those phases hold no leased
 *     worktree, so whatever repo they are standing in is not theirs to change
 *   - only read-only git in the workstream-automation clone or a run's
 *     automation worktrees (wsa, wsa-run), from any phase, plus a plain
 *     `apply`/`add` in a run's wsa; and no starting Cypress or
 *     scripts/localtests.cjs from a session at all (local tests, below)
 *
 * `--no-verify` is deliberately ALLOWED: the husky pre-commit hook in these
 * repos is broken locally and aborts every commit. Lint is enforced as a phase
 * gate instead, which is where it can actually be reported.
 */
const fs = require('node:fs');
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

  if (process.env.ONESHOT_DRY_RUN === '1') {
    C.event('denied_push_dryrun', { cmd: t.join(' ') });
    C.deny(
      'Denied: this is a DRY RUN. Nothing leaves this machine — no push, no MR, no merge. ' +
      'Do the work locally and report what you would have pushed; the run is being exercised ' +
      'end to end precisely because nothing it does is meant to land.',
    );
  }

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

const CONDUCTOR_WRITES = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'am', 'revert', 'stash', 'apply',
]);

/**
 * A phase whose cwd is the conductor holds no leased worktree, so there is no
 * repository it has any claim on — the Oneshot root, the context repo and
 * every other checkout on this laptop are all somebody else's. Reads stay
 * open: recall and review both legitimately inspect history. Writes have
 * nowhere legitimate to land, which makes this cheap to refuse and expensive
 * to allow.
 */
function checkConductorPhase(t) {
  if (!C.phase() || leasedWorktree()) return;
  const sub = t.find((a, i) => i > 0 && !a.startsWith('-') && t[i - 1] !== '-C');
  const mutating = CONDUCTOR_WRITES.has(sub)
    || (sub === 'tag' && t.some((a) => a === '-a' || a === '-d' || a === '-f'))
    || (sub === 'branch' && t.some((a) => a === '-D' || a === '-d' || a === '-m' || a === '--delete'))
    || (sub === 'checkout' && t.some((a) => a === '-B' || a === '-b'))
    || (sub === 'switch' && t.some((a) => a === '-c' || a === '-C'));
  if (!mutating) return;
  C.event('denied_conductor_git_write', { sub, cmd: t.join(' ') });
  C.deny(
    `Denied: \`git ${sub}\` from the '${C.phase()}' phase, which runs in the conductor and has ` +
    'no leased branch or worktree. Whatever repository you are standing in belongs to someone ' +
    'else. Reads — log, diff, show, rev-parse, status, fetch — are fine; changes are not.',
  );
}

const TREE_WRITES = new Set([
  'commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'am', 'revert', 'stash', 'apply',
  'checkout', 'switch', 'restore', 'clean', 'rm', 'mv',
]);

/**
 * A phase that stands in the worktree without the right to write to it —
 * research, plan, testcases, review, ui-evidence, mr — must not reach the
 * files through git either. write-scope.cjs refuses its Edit/Write, and until
 * this check Bash was the way round that: a ui-evidence session ran
 * `git checkout <parent> -- <paths>` in the ticket's own worktree to stage a
 * "before" screenshot, with the fix reverted on disk until it thought to
 * restore it. Had the session died in between, `mr` would have pushed the
 * revert. Push is not in the set: `mr` exists to push commits that implement
 * already made, and checkPush governs where they may go.
 *
 * A git call aimed at an automation checkout is not this check's: the caller
 * skips it once checkLocalTests() has let it through, so local-tests-scope —
 * read-only on its ERP worktree — can still `git -C <run>/wsa apply` its own
 * patch.
 */
function checkReadOnlyWorktreePhase(t) {
  const wt = leasedWorktree();
  if (!C.phase() || !wt) return;
  const scopes = (process.env.ONESHOT_WRITE_SCOPES || '').split(':').filter(Boolean);
  if (scopes.some((s) => C.isInside(wt, s))) return;
  const sub = t.find((a, i) => i > 0 && !a.startsWith('-') && t[i - 1] !== '-C');
  if (!TREE_WRITES.has(sub)) return;
  C.event('denied_readonly_worktree_git', { sub, cmd: t.join(' ') });
  C.deny(
    `Denied: \`git ${sub}\` from the '${C.phase()}' phase. This phase may read the worktree but ` +
    'not change it, and git is not a way around that: the files on disk are the change under ' +
    'review, and anything left altered here can be pushed. If you need the base branch, read it ' +
    'without touching the checkout — `git show origin/<base>:<path>`, `git diff origin/<base>` — ' +
    'or say in your output that you could not produce it.',
  );
}

// --------------------------------------------------------------- local tests

/**
 * The local-tests step runs workstream-automation's Cypress specs against the
 * ticket's code. `local-tests-scope` may edit specs, page objects and fixtures
 * in a throwaway worktree of the automation clone at state/runs/<iid>/wsa, and
 * those edits are TEMPORARY by contract: they travel as
 * artifacts/local-tests/temporary-changes.patch, `local-tests-run` applies
 * that patch to a fresh worktree, and nothing is ever committed to that repo.
 * git is the way to break the contract without touching a file:
 *
 *   - a worktree shares its clone's .git. `stash` lands on the clone's stash
 *     stack, `config` writes the clone's .git/config, `commit` and `reset`
 *     move refs the clone can see — and the clone (ONESHOT_LOCAL_TESTS_REPO)
 *     is a person's checkout.
 *   - the patch is only true of the ref it was cut against. A worktree that
 *     has been checked out, reset, rebased or cleaned under it no longer
 *     describes what the run step will apply.
 *
 * So none of that there, from ANY phase. That includes `checkout -- <path>`,
 * `restore` and `clean`, which CONDUCTOR_WRITES leaves open on purpose:
 * `remediate` uses them to repair a run's own checkout, and judging by target
 * rather than by phase keeps that intact. The same holds for
 * state/runs/<iid>/wsa-run, the worktree local-tests-run checks out and runs
 * Cypress in: it shares the same .git, and it is conductor code's while it
 * exists.
 *
 * It is an ALLOW-list. Reads stay open — reading that repo is the scope
 * session's whole job — and the only writes are a plain `git apply` or
 * `git add` inside a run's wsa, which change that worktree's files and its own
 * index exactly as an Edit would (a redo round re-applies the previous
 * round's patch that way). Everything else is refused. A list of the
 * dangerous subcommands was tried first and missed `remote remove` (it
 * rewrites the person's .git/config and drops refs/remotes/origin/*, after
 * which no prepare-scope can resolve origin/master), `worktree remove` of
 * another ticket's live wsa-run, `branch <new>`, `branch -M`, a lightweight
 * `tag`, `reflog expire` and a fetch whose refspec writes local branches.
 */
const AUTOMATION_READS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'ls-remote', 'grep', 'rev-parse',
  'rev-list', 'cat-file', 'blame', 'annotate', 'describe', 'merge-base', 'shortlog', 'name-rev',
  'show-ref', 'for-each-ref', 'diff-tree', 'diff-files', 'diff-index', 'range-diff', 'cherry',
  'show-branch', 'whatchanged', 'check-ignore', 'check-attr', 'count-objects', 'var', 'help',
  'version',
]);

/** `branch`/`tag` options whose value is the next word, so that word is not a name being created. */
const LIST_VALUE_OPTS = new Set([
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column',
]);

/**
 * A `branch` or `tag` that only lists: no mutating option (short ones may come
 * clustered, `-vD`), and no name to create unless `--list` makes it a pattern.
 */
function listsOnly(args, shortWrites, longWrites) {
  const writes = args.some((a) => {
    if (/^-[A-Za-z0-9]+$/.test(a)) return [...a.slice(1)].some((ch) => shortWrites.includes(ch));
    const long = a.replace(/=.*$/, '');
    return longWrites.includes(long);
  });
  if (writes) return false;
  if (args.some((a) => a === '-l' || a === '--list' || a === '--show-current')) return true;
  for (let i = 0; i < args.length; i += 1) {
    if (LIST_VALUE_OPTS.has(args[i])) i += 1;
    else if (!args[i].startsWith('-')) return false;
  }
  return true;
}

/** `git apply` options that only report on a patch rather than apply it. */
const APPLY_REPORTS = ['--check', '--stat', '--numstat', '--summary'];
const OUTSIDE_WSA = 'would change a checkout other than a run\'s own wsa, the only one a session may change';

/**
 * Why this git call may not run in the automation checkout(s) it targets, or
 * null when it may. `kinds` holds one entry per directory the call acts on:
 * 'clone', 'wsa', 'wsa-run', or null for a directory that is none of them.
 */
function automationRefusal(sub, args, kinds) {
  if (!sub || AUTOMATION_READS.has(sub)) return null;
  const pos = args.filter((a) => !a.startsWith('-'));
  const onlyWsa = kinds.every((k) => k === 'wsa');
  switch (sub) {
    case 'apply':
      if (APPLY_REPORTS.some((r) => args.includes(r)) && !args.includes('--apply')) return null;
      if (args.some((a) => ['--index', '--cached', '--3way', '-3', '--unsafe-paths'].includes(a))) {
        return 'stages or merges as it applies';
      }
      return onlyWsa ? null : OUTSIDE_WSA;
    case 'add':
      return onlyWsa ? null : OUTSIDE_WSA;
    case 'config':
      // `git config <key>` with nothing after it is a read too.
      return args.some((a) => a === '-l' || /^--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list)$/.test(a))
        || pos[0] === 'get' || pos[0] === 'list'
        || (pos.length === 1 && !['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(pos[0])
          && !args.some((a) => /^(?:-e|--edit|--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section)$/.test(a)))
        ? null : 'writes the clone\'s .git/config';
    case 'branch':
      return listsOnly(args, 'dDmMcCfut', [
        '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--set-upstream',
        '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog',
      ]) ? null : 'creates, moves or deletes a branch the clone can see';
    case 'tag':
      return listsOnly(args, 'asudfmFe', [
        '--annotate', '--sign', '--local-user', '--delete', '--force', '--message', '--file',
        '--edit', '--create-reflog', '--cleanup',
      ]) ? null : 'creates or deletes a tag the clone can see';
    case 'remote':
      return !pos.length || pos[0] === 'show' || pos[0] === 'get-url'
        ? null : 'changes the clone\'s remotes, in its .git/config';
    case 'worktree':
      return pos[0] === 'list' ? null : 'adds, moves or removes a worktree of the clone';
    case 'reflog':
      return ['expire', 'delete', 'drop', 'write'].includes(pos[0]) ? 'rewrites the clone\'s reflog' : null;
    case 'fetch':
      // The first positional is the remote; a refspec with a `:` writes the ref it names.
      return pos.slice(1).some((r) => r.includes(':'))
        || args.some((a) => /^(?:-u|-p|-P|--update-head-ok|--prune|--prune-tags|--set-upstream|--refmap(?:=.*)?)$/.test(a))
        ? 'writes local refs, prunes or sets an upstream in the clone' : null;
    default:
      return 'is not one of the read-only commands';
  }
}

/** Expand what the shell would at the head of a path, then resolve it from `base`. */
function resolveFrom(base, raw) {
  return path.resolve(base, C.expandTilde(String(raw)
    .replace(/^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/, C.HOME)
    .replace(/^\$(?:\{ONESHOT_HOME\}|ONESHOT_HOME(?![A-Za-z0-9_]))/, C.ONESHOT)));
}

/** C.isInside, case-folded: on this APFS volume STATE/runs IS state/runs. */
function within(child, parent) {
  const c = C.realish(child).toLowerCase();
  const p = C.realish(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Which automation checkout `p` is in — the clone, one run's wsa worktree (the
 * scope session's) or one run's wsa-run worktree (the run step's) — or null.
 */
function automationTarget(p) {
  const { repo } = C.localTests();
  if (repo && within(p, repo)) return { kind: 'clone', where: `the workstream-automation clone (${repo})` };
  const rel = path.relative(C.realish(path.join(C.STATE, 'runs')).toLowerCase(), C.realish(p).toLowerCase());
  const parts = rel.split(path.sep);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (parts[1] === 'wsa') {
    return { kind: 'wsa', where: `state/runs/${parts[0]}/wsa, a throwaway worktree of the workstream-automation clone` };
  }
  if (parts[1] === 'wsa-run') {
    return { kind: 'wsa-run', where: `state/runs/${parts[0]}/wsa-run, the worktree local-tests-run runs Cypress in` };
  }
  return null;
}

/**
 * A git call's subcommand and arguments, and every directory it acts on: where
 * the shell stands, moved by each `-C`, plus any --git-dir / --work-tree (or
 * GIT_DIR / GIT_WORK_TREE assignment) it names.
 */
function gitCall(t, vars, here) {
  let dir = here;
  const named = [vars.GIT_DIR, vars.GIT_WORK_TREE].filter(Boolean);
  let i = 1;
  for (; i < t.length && t[i].startsWith('-'); i += 1) {
    const a = t[i];
    const eq = a.match(/^--(?:git-dir|work-tree)=(.+)$/);
    if (a === '-C') {
      i += 1;
      dir = resolveFrom(dir, t[i] || '.');
    } else if (a === '--git-dir' || a === '--work-tree') {
      i += 1;
      named.push(t[i] || '.');
    } else if (a === '-c' || a === '--namespace' || a === '--config-env') {
      i += 1;
    } else if (eq) {
      named.push(eq[1]);
    }
  }
  return { sub: t[i] || '', args: t.slice(i + 1), dirs: [dir, ...named.map((p) => resolveFrom(dir, p))] };
}

/**
 * Cypress and scripts/localtests.cjs belong to `local-tests-run`, which is
 * conductor code: it makes this run's copy of the automation database, hands
 * Cypress the credentials from Oneshot's side, and drops the copy, the
 * worktree and the browser afterwards. Started from a session, specs run
 * against whatever database that environment points at, with nothing to clean
 * up after them. No phase has a reason to, so none may — including
 * `local-tests-scope`, which decides what runs and leaves running it to code.
 */
const SCRIPT_RUNNERS = new Set(['node', 'tsx', 'ts-node', 'bun', 'deno', 'sh', 'bash', 'zsh']);
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'yarn', 'pnpm']);
/** The runners whose first positional is the command they run, and after which nothing is theirs. */
const COMMAND_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const CYPRESS = /^cypress(?:@|$)/;
/** Cypress's binary by path: node_modules/.bin/cypress, or anything inside node_modules/cypress/. */
const CYPRESS_BIN = /(?:^|\/)node_modules\/(?:\.bin\/cypress$|cypress\/)/;
const LOCALTESTS = /^localtests\.c?[jt]s$/;
/** Cypress's module API names no binary: `node -e "require('cypress').run()"`. */
const CYPRESS_API = /\b(?:node|tsx|bun|deno)\b[\s\S]*(?:(?:require|import)\s*\(\s*['"]cypress['"]|from\s+['"]cypress['"])/;

/** The body of the package.json script `name` that npm would run from `dir`. */
function packageScript(dir, name) {
  for (let d = dir, i = 0; i < 32; i += 1) {
    const file = path.join(d, 'package.json');
    if (fs.existsSync(file)) {
      try {
        return String((JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {})[name] || '');
      } catch {
        return '';
      }
    }
    if (path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  return '';
}

/** The package.json script a package-manager call runs, or '' for one that runs none. */
function scriptName(argv0, pos) {
  if (argv0 === 'yarn' || argv0 === 'pnpm') return (pos[0] === 'run' ? pos[1] : pos[0]) || '';
  if (argv0 !== 'npm') return '';
  if (['run', 'run-script', 'rum', 'urn'].includes(pos[0])) return pos[1] || '';
  if (['t', 'test', 'tst'].includes(pos[0])) return 'test';
  return pos[0] === 'start' ? 'start' : '';
}

/**
 * npm/npx/yarn/pnpm options whose value is the next word. Without this an
 * option's value read as the command: `npx --cache /tmp/c cypress run` looked
 * like it ran `/tmp/c`.
 */
const PKG_VALUE_OPTS = new Set([
  '--prefix', '-C', '--dir', '--cwd', '--cache', '--registry', '--userconfig', '--globalconfig',
  '--workspace', '--loglevel', '--package', '--call', '--script-shell', '--node-options',
  '--filter', '-F', '--reporter', '--tag', '--include', '--omit',
]);
/** Short options that take a value for some runners and are flags for others (npx -p, npm -p). */
const PKG_MAYBE_VALUE_OPTS = new Set(['-p', '-c', '-w']);
/** The value options that move where package.json is read from. */
const PKG_DIR_OPTS = new Set(['--prefix', '-C', '--dir', '--cwd']);
/** Long options known to take no value, which the greedy reading must not hand the next word. */
const PKG_FLAGS = new Set([
  '--yes', '--quiet', '--silent', '--ignore-existing', '--prefer-offline', '--prefer-online',
  '--offline', '--ws', '--workspaces', '--include-workspace-root', '--if-present', '--verbose',
  '--global', '--save', '--save-dev', '--force', '--legacy-peer-deps', '--dry-run', '--json',
  '--parseable', '--recursive', '--frozen-lockfile', '--color', '--shamefully-hoist',
]);

/**
 * A package runner's arguments as the runner reads them: the positionals, the
 * directories --prefix/-C/--dir/--cwd point at, and any -c/--call command.
 * npx-like runners stop reading options at their command; npm reads them
 * anywhere before `--`, so `npm run report --prefix <wsa>` runs <wsa>'s
 * script. `greedy` is the second reading testRunner() asks for: npm gives an
 * unknown `--option` the next word as its value, and the ambiguous short
 * options take theirs.
 */
function packageArgs(args, greedy, commandRunner) {
  const out = { pos: [], dirs: [], calls: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      out.pos.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      if (commandRunner) {
        out.pos.push(...args.slice(i));
        break;
      }
      out.pos.push(a);
      continue;
    }
    const eq = a.match(/^(-[^=]+)=(.*)$/);
    let opt = a;
    let val = null;
    if (eq) {
      [, opt, val] = eq;
    } else if ((PKG_VALUE_OPTS.has(a)
      || (greedy && (PKG_MAYBE_VALUE_OPTS.has(a) || (a.startsWith('--') && !PKG_FLAGS.has(a) && !a.startsWith('--no-')))))
      && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      val = args[i + 1];
      i += 1;
    }
    if (val !== null && PKG_DIR_OPTS.has(opt)) out.dirs.push(val);
    if (val !== null && (opt === '-c' || opt === '--call')) out.calls.push(val);
  }
  return out;
}

/**
 * What a package-manager call starts, read both ways packageArgs() offers and
 * refused if either reading runs Cypress or the run script. Its package.json
 * script is looked up where --prefix/-C/--dir/--cwd point as well as where the
 * shell stands.
 */
function packageRunner(argv0, args, here) {
  const commandRunner = COMMAND_RUNNERS.has(argv0);
  for (const greedy of [false, true]) {
    const { pos, dirs, calls } = packageArgs(args, greedy, commandRunner);
    const cmd = commandRunner || !['exec', 'x', 'dlx'].includes(pos[0]) ? pos[0] : pos[1];
    if ([cmd, ...calls].some((c) => c && (CYPRESS.test(c) || CYPRESS_BIN.test(c)))) return 'Cypress';
    if (pos.some((a) => LOCALTESTS.test(path.basename(a)))) return 'scripts/localtests.cjs';
    // `npm run report` is `cypress run` in workstream-automation's package.json.
    const name = scriptName(argv0, pos);
    if (!name) continue;
    for (const dir of [...dirs.map((d) => resolveFrom(here, d)), here]) {
      const body = packageScript(dir, name);
      if (/\bcypress\b/.test(body)) return 'Cypress';
      if (/localtests\.c?[jt]s/.test(body)) return 'scripts/localtests.cjs';
    }
  }
  return null;
}

/** 'Cypress' or 'scripts/localtests.cjs' when this argv starts one, else null. */
function testRunner(t, here) {
  const argv0 = path.basename(t[0] || '');
  const pos = t.slice(1).filter((a) => !a.startsWith('-'));
  const first = pos[0] || '';
  if (argv0 === 'cypress') return 'Cypress';
  if (LOCALTESTS.test(argv0)) return 'scripts/localtests.cjs';
  // `bash -c "npx cypress run"`: tokens() has dropped the quotes, so the payload is the rest.
  if (['sh', 'bash', 'zsh'].includes(argv0) && t.includes('-c')) {
    return testRunner(t.slice(t.indexOf('-c') + 1), here);
  }
  if (SCRIPT_RUNNERS.has(argv0)) {
    if (path.basename(first) === 'cypress' || first.includes('node_modules/cypress/')) return 'Cypress';
    if (LOCALTESTS.test(path.basename(first))) return 'scripts/localtests.cjs';
    return null;
  }
  if (!PACKAGE_RUNNERS.has(argv0)) return null;
  return packageRunner(argv0, t.slice(1), here);
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'nohup', 'time', 'nice']);
/**
 * The wrappers whose own options are skipped, with the options that take a
 * value. `command` and `exec` are not here: `command -v cypress` looks the
 * binary up, it does not run it.
 */
const WRAPPER_VALUE_OPTS = new Map([
  ['env', new Set(['-u', '--unset', '-C', '--chdir'])],
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-U', '-r', '-t'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['time', new Set(['-o', '--output', '-f', '--format'])],
]);
/** `timeout`'s options that take a value; the duration comes after them. */
const TIMEOUT_VALUE_OPTS = new Set(['-s', '--signal', '-k', '--kill-after']);

/** Shift `t`'s leading options, and the value of each one in `valued`. */
function shiftOptions(t, valued) {
  while (t.length && t[0].startsWith('-') && t[0] !== '-') {
    const opt = t.shift();
    if (valued.has(opt)) t.shift();
  }
}

/**
 * Strip what stands in front of argv[0] without changing what runs: env
 * assignments (returned, for GIT_DIR and GIT_WORK_TREE), plain wrappers with
 * their options, and `timeout` with its options and duration — the obvious way
 * to bound a long Cypress run, `timeout -k 10 900 npx cypress run` included.
 */
function unwrap(t) {
  const vars = {};
  while (t.length) {
    const m = t[0].match(/^([A-Za-z_]\w*)=(.*)$/);
    if (m) {
      vars[m[1]] = m[2];
      t.shift();
    } else if (t[0] === 'timeout' || t[0] === 'gtimeout') {
      t.shift();
      shiftOptions(t, TIMEOUT_VALUE_OPTS);
      t.shift();
    } else if (WRAPPERS.has(t[0])) {
      const valued = WRAPPER_VALUE_OPTS.get(t.shift());
      if (valued) shiftOptions(t, valued);
    } else {
      break;
    }
  }
  return vars;
}

/**
 * Walks the command in order, so a `cd` moves where every later segment
 * stands: `cd state/runs/12/wsa && git stash` is a stash in the worktree.
 *
 * Returns the indexes (into segments(cmd)) of the git calls aimed at an
 * automation checkout that it let through. Those are this check's to judge:
 * checkReadOnlyWorktreePhase() looks at the ERP worktree the phase stands in,
 * and refused the redo round's `git -C <wsa> apply <patch>` from
 * local-tests-scope, whose leased worktree is read-only to it, for a change
 * that never touches that worktree.
 */
function checkLocalTests(cmd, data) {
  if (CYPRESS_API.test(cmd)) denyTestRunner('Cypress');
  const governed = new Set();
  let here = data.cwd || leasedWorktree() || C.ONESHOT;
  const segs = segments(cmd);
  for (let idx = 0; idx < segs.length; idx += 1) {
    const seg = segs[idx];
    const t = tokens(seg.replace(/^[({]+\s*/, '').replace(/\s*\)+$/, ''));
    const vars = unwrap(t);
    if (!t.length) continue;
    if (t[0] === 'cd' || t[0] === 'pushd') {
      const to = t.slice(1).find((a) => a === '-' || !a.startsWith('-'));
      if (to === undefined && t[0] === 'cd') here = C.HOME;
      else if (to && to !== '-') here = resolveFrom(here, to);
      continue;
    }
    const runner = testRunner(t, here);
    if (runner) denyTestRunner(runner);

    if (path.basename(t[0]) !== 'git') continue;
    const call = gitCall(t, vars, here);
    const targets = call.dirs.map(automationTarget);
    if (!targets.some(Boolean)) continue;
    const why = automationRefusal(call.sub, call.args, targets.map((x) => (x ? x.kind : null)));
    if (!why) {
      governed.add(idx);
      continue;
    }
    // Name the checkout the call may not change: a non-wsa one when there is one.
    const target = targets.find((x) => x && x.kind !== 'wsa') || targets.find(Boolean);
    C.event('denied_automation_git', { sub: call.sub, where: target.where, cmd: seg.slice(0, 120) });
    C.deny(
      `Denied: \`git ${call.sub}\` in ${target.where} — it ${why}. That clone is a person's ` +
      'checkout, and every run worktree of it shares its .git: a stash, commit, reset, branch, ' +
      'remote or config change made there lands in the clone. Nothing is ever committed to ' +
      'workstream-automation from a run: temporary edits to specs, page objects and fixtures stay ' +
      'as working-tree changes in state/runs/<iid>/wsa and travel as ' +
      'artifacts/local-tests/temporary-changes.patch, which the run step applies to a fresh ' +
      'worktree. Read-only git is fine (status, diff, log, show, ls-files, ls-tree, grep, blame, ' +
      'rev-parse, cat-file, fetch without a refspec, config --get/--list, listing branches, tags, ' +
      'remotes or worktrees), and so is a plain `git apply` or `git add` in a run\'s wsa. To undo ' +
      'one of your temporary edits, edit the file back.',
    );
  }
  return governed;
}

function denyTestRunner(what) {
  C.event('denied_test_runner', { what });
  C.deny(
    `Denied: starting ${what} from the '${C.phase()}' phase. Specs run in the local-tests-run ` +
    'step, which is conductor code: it copies the automation database for this run, hands ' +
    'Cypress its credentials, and drops the copy and the browser afterwards. Started from here, ' +
    'specs would hit whatever database your environment points at, with nothing to clean up ' +
    'after them. If different specs should run, say so in your output — `local-tests-scope` ' +
    'lists them in `specs` and `proposals`; any other phase reports it in `summary` or `blocked`.',
  );
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
    // First, so a session in the automation clone hears why that repo is
    // special rather than only that it is outside the worktree.
    const governed = checkLocalTests(cmd, data);
    checkCwd(cmd);

    const segs = segments(cmd);
    for (let idx = 0; idx < segs.length; idx += 1) {
      const seg = segs[idx];
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

      checkConductorPhase(t);
      if (!governed.has(idx)) checkReadOnlyWorktreePhase(t);
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
