#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: a phase may not rewrite another phase's handoff, or the journal.
 *
 * WHY THIS IS A HOOK. Every session phase declares `writes: ['run']`, which
 * hands it the whole run directory — and that directory is where every phase's
 * handoff artifact and `run.json` live. What a phase is actually TOLD to write
 * there is three files: `testcases-partial.json`, `review-partial.json` and
 * `verify-partial.json` (the crash backstops). `src/phases/prompts.ts` is
 * explicit about it — "Your one legal write is the review-partial.json backstop
 * above, under the run directory — nothing else." The permission is wider than
 * the need by every handoff in that directory, and the gap is not cosmetic:
 *
 *   - `qualityGate()` in src/conductor/codephases.ts decides the merge by
 *     reading `verify.json` and `findings.json` back off disk. `verify` (n:6),
 *     `ui-evidence` (n:7) and `mr` (n:8) all run AFTER `review` (n:5) and all
 *     hold this scope. A verify session that cannot make its cases pass could
 *     instead delete the blocker findings that stand in front of its merge.
 *   - `run.json` is the journal. It carries `planApproval`, `testcasesApproval`
 *     and `mergedSha` — the record of what a HUMAN signed off in GitLab. The
 *     drift detection built for exactly this (reviewgate.ts's `approvedDigest`)
 *     stores its digests in that same file, so the integrity record can be
 *     rewritten alongside the thing it is meant to protect.
 *   - `runner.ts` rebuilds `prior[]` from these files on resume and for skipped
 *     phases, and `prior[]` is what every later phase's prompt is built from.
 *     A rewrite is context poisoning as much as it is a gate bypass.
 *
 * A phase's OWN artifact needs no guarding: phase.ts writes it from the
 * session's structured output after the session is dead, clobbering whatever
 * the session left. It is the EARLIER phases' artifacts that persist, so the
 * deny list is every declared artifact rather than "all but yours" — a phase
 * has no business writing its own either, and a uniform list is one rule to
 * read instead of a table.
 *
 * WHY BASH IS CHECKED TOO. write-scope.cjs matches Write/Edit/NotebookEdit
 * only, so Bash is already the documented way around it (see phase.ts's note on
 * the heredoc hole). This is not hypothetical here: the event log shows
 * `remediate` reading all four of `findings.json`, `implement.json`,
 * `verify.json` and `testcases.json` in one lap of run 182 — with `cat` and
 * `python3 -c "json.load(...)"`. The sessions already reach these files by
 * absolute path through Bash. Only the verb differs, and a `json.dump` in one
 * of those one-liners is invisible to a write-tool matcher.
 *
 * The Bash arm is pattern matching, not a shell parser, and is therefore
 * best-effort in the same way secret-guard.cjs declares itself to be. What
 * keeps that honest is the narrowness of the subject: it considers ONLY the
 * exact basenames of every declared artifact plus run.json, directly inside a
 * run directory, and reads are left completely alone. There is no legitimate
 * command that writes one of them, so the cost of the patterns it misses is a
 * gap, never a false positive.
 *
 * The names are derived from config/phases.json rather than listed here, the
 * way frontend-test-guard derives Jest's collection rules from the app repo's
 * own package.json: a phase renamed or added in config cannot leave this guard
 * silently protecting a file that no longer exists.
 *
 * Fail-open, like every guard here.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

/**
 * The journal. Not a phase artifact, and the most valuable file in the
 * directory: it is where a human's gate approval is recorded.
 */
const JOURNAL = 'run.json';

/**
 * Used only when config/phases.json cannot be read. A guard that protects
 * nothing when its config is missing would be indistinguishable from one that
 * ran, so it falls back to the list as it stands today — the same reason
 * git-guard carries a default branch policy.
 */
const FALLBACK = [
  'recall.json', 'research.json', 'design.json', 'plan.json', 'implement.json',
  'mr-open.json', 'testcases.json', 'findings.json', 'verify.json',
  'ui-evidence.json', 'mr.json', 'merge.json', 'remediate.json', 'mr-feedback.json',
];

function protectedNames() {
  const cfg = C.loadConfig('phases.json');
  const phases = cfg && Array.isArray(cfg.phases) ? cfg.phases : null;
  if (!phases) return new Set([...FALLBACK, JOURNAL]);
  const names = phases
    .filter((p) => p && p.name)
    .map((p) => p.artifact || `${p.name}.json`);
  return new Set([...names, JOURNAL]);
}

function runsRoot() { return path.join(C.STATE, 'runs'); }

/**
 * Is this path a protected file sitting DIRECTLY in some run's directory?
 *
 * Depth matters. `<run>/artifacts/verify.json` and `<run>/scratch/plan.json`
 * are a session's own scratch space and none of this guard's business; only
 * `<run>/verify.json` is a handoff. Any run's, not just this one's — the Bash
 * surface can name another run's directory, and cross-run tampering is the
 * same failure with somebody else's ticket attached.
 */
function protectedArtifact(p, names) {
  if (!p) return null;
  const root = C.realish(runsRoot());
  const abs = C.realish(p);
  if (!C.isInside(abs, root) || abs === root) return null;
  const parts = path.relative(root, abs).split(path.sep);
  if (parts.length !== 2) return null;
  if (!names.has(parts[1])) return null;
  return { iid: parts[0], name: parts[1] };
}

function refuse(hit, how) {
  const own = hit.name === JOURNAL
    ? 'That file is the run journal: it holds the plan and test-case approvals a '
      + 'human gave on the ticket, and the merge SHA. Nothing in a session writes it.'
    : `That file is the '${hit.name.replace(/\.json$/, '')}' phase's handoff. The conductor `
      + 'writes it from a phase\'s structured output, and reads it back to decide whether this '
      + 'change merges.';
  C.event('denied_artifact_write', { via: how, iid: hit.iid, name: hit.name, phase: C.phase() });
  C.deny(
    `Denied: ${how} would write state/runs/${hit.iid}/${hit.name}. ${own}\n`
    + 'Reading it is fine — this guard only refuses writes. If what it holds is wrong, say so '
    + 'in your own output (`summary`, or `blocked` if it stops you): the conductor acts on what '
    + 'you return, and a phase that edits the record instead of reporting it makes the run '
    + 'undiagnosable. The only files you may write in that directory are the '
    + '`*-partial.json` crash backstops your prompt names.',
  );
}

// ------------------------------------------------------------------ bash arm

/**
 * Split a compound command into individually-checkable segments.
 *
 * A single `|` is a separator too, exactly as in git-guard: the right-hand side
 * of a pipe is its own command, and `echo '{}' | tee <handoff>` is a write whose
 * argv[0] is `echo` until the pipe is split on.
 */
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg) {
  return seg.replace(/["']/g, '').split(/\s+/).filter(Boolean);
}

/**
 * Commands whose job is to replace or destroy a file named as an argument.
 *
 * `sed` is here only with `-i`; without it sed is a reader. `touch` is
 * deliberately absent — it moves an mtime, not a byte.
 */
const DEST_LAST = new Set(['cp', 'mv', 'install', 'rsync']);
const ANY_ARG = new Set(['rm', 'shred', 'truncate', 'tee', 'unlink']);

/** Every path this command appears to WRITE. Reads are not collected at all. */
function writeTargets(cmd) {
  const found = [];
  const raw = String(cmd || '');

  // Shell redirection, the common case: `> f`, `>> f`, `2> f`, `>| f`.
  const redirect = /(?:^|[\s;&|])\d*>>?\|?\s*(["']?)([^\s"'|;&<>]+)\1/g;
  for (let m = redirect.exec(raw); m; m = redirect.exec(raw)) found.push(m[2]);

  // Interpreter one-liners. `python3 -c "... json.dump(d, open(p,'w'))"` is the
  // shape the transcripts show these sessions reaching for, so the write MODE
  // is what is matched — an `open(p)` or `open(p,'r')` is a read and ignored.
  const pyOpen = /open\(\s*(["'])([^"']+)\1\s*,\s*(["'])[wax]/g;
  for (let m = pyOpen.exec(raw); m; m = pyOpen.exec(raw)) found.push(m[2]);
  const pyWrite = /(?:write_text|write_bytes)\(|Path\(\s*(["'])([^"']+)\1\s*\)\s*\.\s*open\(\s*(["'])[wa]/g;
  for (let m = pyWrite.exec(raw); m; m = pyWrite.exec(raw)) if (m[2]) found.push(m[2]);
  const nodeWrite = /(?:writeFileSync|appendFileSync|createWriteStream|writeFile)\(\s*(["'`])([^"'`]+)\1/g;
  for (let m = nodeWrite.exec(raw); m; m = nodeWrite.exec(raw)) found.push(m[2]);

  for (const seg of segments(raw)) {
    const t = tokens(seg);
    if (!t.length) continue;
    // `cmd` may be prefixed by env assignments or `sudo`.
    let i = 0;
    while (i < t.length && (/^[A-Z_][A-Z0-9_]*=/.test(t[i]) || t[i] === 'sudo' || t[i] === 'env')) i += 1;
    const argv0 = path.basename(t[i] || '');
    const args = t.slice(i + 1).filter((a) => !a.startsWith('-'));

    // Braces on every branch, including the one-statement ones. Without them
    // the `for` below swallows the following `else if`s as the body of its own
    // inner `if`, and `rm`/`tee`/`cp` silently stop being checked while the
    // rest of the guard still passes its tests.
    if (argv0 === 'sed' && t.includes('-i')) {
      found.push(...args);
    } else if (argv0 === 'dd') {
      for (const a of t) {
        if (a.startsWith('of=')) found.push(a.slice(3));
      }
    } else if (ANY_ARG.has(argv0)) {
      found.push(...args);
    } else if (DEST_LAST.has(argv0) && args.length >= 2) {
      found.push(args[args.length - 1]);
    }
  }
  return found;
}

/**
 * Every directory a relative path in this command could have meant.
 *
 * A phase's cwd is the worktree or $ONESHOT_HOME depending on its `cwd` in
 * config/phases.json, and the guard does not get told which — so it resolves
 * against both rather than guessing. Resolving against a base the session was
 * not standing in can only ever produce a path that is not a handoff, so the
 * extra candidate costs nothing and the wrong guess would cost the whole check:
 * the observed `cat state/runs/182/findings.json` was relative, from a
 * conductor-cwd phase, and a worktree-relative reading of it lands nowhere.
 */
function resolveFrom(p) {
  const target = C.expandTilde(String(p).replace(/^\$HOME|^\$\{HOME\}/, C.HOME));
  if (path.isAbsolute(target)) return [target];
  const bases = [process.env.ONESHOT_WORKTREE, C.ONESHOT].filter(Boolean);
  return bases.map((b) => path.join(b, target));
}

// ----------------------------------------------------------------- dispatch

function targetPath(data) {
  const i = data.tool_input || {};
  return i.file_path || i.notebook_path || i.path || '';
}

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const names = protectedNames();

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const hit = protectedArtifact(targetPath(data), names);
    if (hit) refuse(hit, `${tool} of`);
  }

  if (tool === 'Bash') {
    const cmd = (data.tool_input || {}).command || '';
    // Cheap pre-filter: nothing to do unless a protected basename is mentioned
    // at all, which is the overwhelming majority of commands.
    if ([...names].some((n) => cmd.includes(n))) {
      for (const raw of writeTargets(cmd)) {
        for (const candidate of resolveFrom(raw)) {
          const hit = protectedArtifact(candidate, names);
          if (hit) refuse(hit, 'this command');
        }
      }
    }
  }
} catch (err) {
  C.logFailure('artifact-guard', err);
}

C.allow();
