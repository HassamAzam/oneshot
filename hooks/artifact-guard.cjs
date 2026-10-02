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
 * `python3 -c "json.load(...)"`. The sessions already reach these files through
 * Bash, by absolute path and just as often by `cd`-ing into the run directory
 * and naming the bare basename: 62 of the 168 logged Bash commands that name a
 * run-dir artifact (2026-10-02) start `cd …/state/runs/<iid> &&`. Only the verb
 * differs, and a `json.dump` in one of those one-liners is invisible to a
 * write-tool matcher.
 *
 * The Bash arm is pattern matching, not a shell parser, and is therefore
 * best-effort in the same way secret-guard.cjs declares itself to be. What
 * keeps that honest is the narrowness of the subject: it considers ONLY the
 * exact basenames of every declared artifact plus run.json, directly inside a
 * run directory — and, for a command that deletes or moves a whole directory,
 * only a run directory or the runs root itself. Reads are left completely
 * alone. There is no legitimate command that writes one of them, so the cost of
 * the patterns it misses is a gap, never a false positive.
 *
 * The names are derived from config/phases.json rather than listed here, the
 * way frontend-test-guard derives Jest's collection rules from the app repo's
 * own package.json: a phase renamed or added in config cannot leave this guard
 * silently protecting a file that no longer exists.
 *
 * Fail-open, like every guard here.
 */
const fs = require('node:fs');
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

/**
 * Lower-cased, because the volume this runs on is not case-sensitive: on APFS a
 * Write of `<run>/Findings.json` lands on findings.json, and a set holding only
 * the spelling config uses let it straight through.
 */
function protectedNames() {
  const cfg = C.loadConfig('phases.json');
  const phases = cfg && Array.isArray(cfg.phases) ? cfg.phases : null;
  const names = phases
    ? phases.filter((p) => p && p.name).map((p) => p.artifact || `${p.name}.json`)
    : FALLBACK;
  return new Set([...names, JOURNAL].map((n) => n.toLowerCase()));
}

/**
 * C.realish(), resolved with realpathSync.native, which returns the case a
 * path has ON DISK.
 *
 * realish() uses the JS realpath, which keeps the case as typed. On a
 * case-insensitive APFS volume `<home>/STATE/runs/0/findings.json` IS the
 * handoff, yet compared as typed it is not even inside the runs root. The
 * native call settles every part of the path that exists; a part that does not
 * exist yet keeps its typed case, which the lower-cased name compare covers.
 */
function canonical(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(abs)) {
      try {
        return path.join(fs.realpathSync.native(abs), ...tail.reverse());
      } catch {
        return path.join(abs, ...tail.reverse());
      }
    }
    const parent = path.dirname(abs);
    if (parent === abs) break;
    tail.push(path.basename(abs));
    abs = parent;
  }
  return path.resolve(p);
}

function runsRoot() { return canonical(path.join(C.STATE, 'runs')); }

/** The path's components below the runs root ([] for the root), or null when outside it. */
function belowRuns(p) {
  if (!p) return null;
  const root = runsRoot();
  const abs = canonical(p);
  if (!C.isInside(abs, root)) return null;
  return abs === root ? [] : path.relative(root, abs).split(path.sep);
}

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
  const parts = belowRuns(p);
  if (!parts || parts.length !== 2) return null;
  if (!names.has(parts[1].toLowerCase())) return null;
  return { iid: parts[0], name: parts[1] };
}

/**
 * Is this path a whole run directory, or the runs root?
 *
 * `rm -rf <run>` deletes the journal and every handoff at once while naming
 * none of them, so the basename check above never sees it. Nothing deeper
 * counts: `rm -rf <run>/scratch` is a session tidying its own space.
 */
function runDirectory(p) {
  const parts = belowRuns(p);
  if (!parts || parts.length > 1) return null;
  return { iid: parts.length ? parts[0] : '*', name: null };
}

function refuse(hit, how) {
  C.event('denied_artifact_write', { via: how, iid: hit.iid, name: hit.name, phase: C.phase() });
  if (!hit.name) {
    const where = hit.iid === '*' ? 'state/runs' : `state/runs/${hit.iid}`;
    C.deny(
      `Denied: ${how} would delete or move ${where}. That is where the run journal lives — `
      + 'the plan and test-case approvals a human gave on the ticket, and the merge SHA — '
      + 'together with every phase\'s handoff, which the conductor reads back to decide whether '
      + 'this change merges. Nothing in a session removes it.\n'
      + 'If what is in there is wrong, say so in your own output (`summary`, or `blocked` if it '
      + 'stops you): the conductor acts on what you return. Your own scratch one level down '
      + '(`scratch/`, `artifacts/`) is yours to delete.',
    );
  }
  const own = hit.name.toLowerCase() === JOURNAL
    ? 'That file is the run journal: it holds the plan and test-case approvals a '
      + 'human gave on the ticket, and the merge SHA. Nothing in a session writes it.'
    : `That file is the '${hit.name.replace(/\.json$/i, '')}' phase's handoff. The conductor `
      + 'writes it from a phase\'s structured output, and reads it back to decide whether this '
      + 'change merges.';
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
 * argv[0] is `echo` until the pipe is split on. The `|` of a `>|` redirect is
 * not one — it is part of the operator, and splitting there strands the target.
 *
 * A subshell's `(` and `)` and a group's `{ ` are dropped from the ends of a
 * segment, or `(cd <run> && rm verify.json)` reads as argv[0] `(cd` followed by
 * a file called `verify.json)`, and neither half is recognised.
 */
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|(?<!>)\|/g)
    .map((s) => s.trim().replace(/^(?:\(|\{\s)+\s*/, '').replace(/\s*\)+$/, ''))
    .filter(Boolean);
}

function tokens(seg) {
  return seg.replace(/["']/g, '').split(/\s+/).filter(Boolean);
}

/** Expand what the shell would at the head of a path: `~`, $HOME and $ONESHOT_HOME, braced or not. */
function expandVars(p) {
  return C.expandTilde(String(p)
    .replace(/^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/, C.HOME)
    .replace(/^\$(?:\{ONESHOT_HOME\}|ONESHOT_HOME(?![A-Za-z0-9_]))/, C.ONESHOT));
}

/**
 * Commands whose job is to replace or destroy a file named as an argument.
 *
 * `sed` is here only with `-i`; without it sed is a reader. `touch` is
 * deliberately absent — it moves an mtime, not a byte.
 *
 * `mv` takes its SOURCE away as surely as it replaces its destination, so every
 * argument counts: with only the last one checked, `mv <run>/findings.json
 * /tmp/x` deleted the blocker findings — the exact attack this guard names —
 * while `rm` of the same file was refused.
 */
const DEST_LAST = new Set(['cp', 'install', 'rsync']);
const ANY_ARG = new Set(['rm', 'shred', 'truncate', 'tee', 'unlink', 'mv']);
/** Commands that, given a directory as the destination, write `<dest>/<basename of source>`. */
const INTO_DIR = new Set(['cp', 'install', 'rsync', 'mv']);
/** Commands that remove the directories they name, which runDirectory() checks. */
const REMOVERS = new Set(['rm', 'rmdir', 'shred', 'unlink']);

/** argv[0] past any env assignments and `sudo`, and the arguments after it. */
function command(seg) {
  const t = tokens(seg);
  let i = 0;
  while (i < t.length && (/^[A-Z_][A-Z0-9_]*=/.test(t[i]) || t[i] === 'sudo' || t[i] === 'env')) i += 1;
  const rest = t.slice(i + 1);
  return {
    argv0: path.basename(t[i] || ''),
    rest,
    args: rest.filter((a) => !a.startsWith('-')),
  };
}

/** Where the shell stands after `cd`/`pushd`, given every directory it might have stood in. */
function chdir(dirs, argv0, rest) {
  const arg = rest.find((a) => a === '-' || !a.startsWith('-'));
  if (arg === undefined) return argv0 === 'cd' ? [C.HOME] : dirs;
  if (arg === '-') return dirs;
  const d = expandVars(arg);
  if (path.isAbsolute(d)) return [d];
  return [...new Set(dirs.map((b) => path.resolve(b, d)))];
}

/**
 * Every literal path an interpreter call in `text` appears to WRITE.
 *
 * Run over each segment by writeTargets(), and once more over the whole
 * command by the dispatch below. segments() splits on newlines, so a heredoc
 * that puts its path on the line after the call —
 *
 *   python3 - <<'EOF'
 *   with open(
 *       "<run>/verify.json", "w") as f:
 *
 * — leaves `open(` in one segment and the path in the next, and neither
 * matches. Scanning the raw command (as the guard did before it walked
 * segments) refused that; walking segments alone let it through.
 */
function interpreterWrites(text) {
  const found = [];
  // Interpreter one-liners. `python3 -c "... json.dump(d, open(p,'w'))"` is the
  // shape the transcripts show these sessions reaching for, so the write MODE
  // is what is matched — an `open(p)` or `open(p,'r')` is a read and ignored.
  // 'r+' is a write that starts with an r, so it is spelled out.
  const pyOpen = /open\(\s*(["'])([^"']+)\1\s*,\s*(["'])(?:[wax]|r\+|rb\+)/g;
  for (let m = pyOpen.exec(text); m; m = pyOpen.exec(text)) found.push(m[2]);
  // Every alternative hangs off the one Path(...) capture: a bare
  // `write_text(` alternative matched without capturing a path, and the write
  // it was written to catch was dropped.
  const pyPath = /Path\(\s*(["'])([^"']+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|rename|replace|open\(\s*(["'])(?:[wax]|r\+|rb\+))/g;
  for (let m = pyPath.exec(text); m; m = pyPath.exec(text)) found.push(m[2]);
  // os/shutil by literal path. A move or rename takes its source away and
  // overwrites its destination, so both count; a copy only writes its
  // destination — copying a handoff OUT is a read.
  const pyFs = /\b(os\.(?:remove|unlink|rename|replace)|shutil\.(?:move|copy|copy2|copyfile))\(\s*(["'])([^"']+)\2(?:\s*,\s*(["'])([^"']+)\4)?/g;
  for (let m = pyFs.exec(text); m; m = pyFs.exec(text)) {
    const copies = m[1].startsWith('shutil.copy');
    if (!copies) found.push(m[3]);
    if (m[5]) found.push(m[5], path.join(m[5], path.basename(m[3])));
  }
  const nodeWrite = /(?:writeFileSync|appendFileSync|createWriteStream|writeFile)\(\s*(["'`])([^"'`]+)\1/g;
  for (let m = nodeWrite.exec(text); m; m = nodeWrite.exec(text)) found.push(m[2]);
  return found;
}

/** Every path this segment appears to WRITE. Reads are not collected at all. */
function writeTargets(seg, { argv0, rest, args }) {
  const found = [];

  // Shell redirection, the common case: `> f`, `>> f`, `2> f`, `>| f`.
  const redirect = /(?:^|[\s;&|])\d*>>?\|?\s*(["']?)([^\s"'|;&<>]+)\1/g;
  for (let m = redirect.exec(seg); m; m = redirect.exec(seg)) found.push(m[2]);

  found.push(...interpreterWrites(seg));

  // Braces on every branch, including the one-statement ones. Without them
  // the `for` below swallows the following `else if`s as the body of its own
  // inner `if`, and `rm`/`tee`/`cp` silently stop being checked while the
  // rest of the guard still passes its tests.
  //
  // sed's in-place flag comes as `-i`, `-i.bak`, `-Ei` or `--in-place[=…]`;
  // matching only the bare `-i` let the other three through.
  if (argv0 === 'sed' && rest.some((a) => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) {
    found.push(...args);
  } else if (argv0 === 'dd') {
    for (const a of rest) {
      if (a.startsWith('of=')) found.push(a.slice(3));
    }
  } else if (ANY_ARG.has(argv0)) {
    found.push(...args);
  } else if (argv0 === 'rsync' && rest.includes('--remove-source-files')) {
    found.push(...args);
  } else if (DEST_LAST.has(argv0) && args.length >= 2) {
    found.push(args[args.length - 1]);
  }

  // `cp /tmp/verify.json <run>/` names no handoff — the destination is the run
  // directory, and the file lands at <run>/verify.json. The depth check in
  // protectedArtifact keeps this from flagging a copy to a plain file path.
  if (INTO_DIR.has(argv0) && args.length >= 2) {
    const dest = args[args.length - 1];
    for (const src of args.slice(0, -1)) found.push(path.join(dest, path.basename(src)));
  }
  return found;
}

/** The directories this segment deletes or takes away, for runDirectory(). */
function removedPaths({ argv0, rest, args }) {
  if (REMOVERS.has(argv0)) return args;
  if (argv0 === 'mv') return args.slice(0, -1);
  if (argv0 === 'rsync' && rest.includes('--remove-source-files')) return args.slice(0, -1);
  return [];
}

/**
 * `find <root> -name findings.json -delete` (or `-exec rm`) deletes a handoff
 * without ever spelling its path. Returns the search roots and the protected
 * names the command filters on, or null when it is not a destructive find over
 * a protected name.
 */
function findDeletes({ argv0, rest }, names) {
  if (argv0 !== 'find') return null;
  const destructive = rest.includes('-delete') || rest.some((a, i) =>
    /^-(?:exec|execdir|ok|okdir)$/.test(a)
    && ['rm', 'unlink', 'shred', 'mv'].includes(path.basename(rest[i + 1] || '')));
  if (!destructive) return null;
  const named = rest.filter((a, i) => /^-i?name$/.test(rest[i - 1] || '') && names.has(a.toLowerCase()));
  if (!named.length) return null;
  const roots = [];
  for (const a of rest) {
    if (/^[-(!]/.test(a)) break;
    roots.push(a);
  }
  return { roots: roots.length ? roots : ['.'], named };
}

/**
 * Every path a target in this command could mean, given where the shell might
 * be standing.
 *
 * The hook input carries the session's `cwd`, and secret-guard already reads
 * it. Ignoring it — and any `cd` earlier in the same command — is what let
 * `cd <run> && rm findings.json` through, which is the commonest shape these
 * sessions use on these files.
 *
 * startingDirs() adds the worktree and $ONESHOT_HOME to that, and the extra
 * bases cost nothing ONLY to a check that asks whether a path IS one exact spot
 * below state/runs — a handoff (protectedArtifact) or a run directory
 * (runDirectory). From a base the session was not standing in, a relative path
 * lands on such a spot only when it spells the way down itself, as the observed
 * `cat state/runs/182/findings.json` from a conductor-cwd phase did. A check
 * that asks whether a path is at or ABOVE state/runs gets no such protection:
 * `.` resolved against $ONESHOT_HOME always is, which refused `find . -name
 * plan.json -delete` run inside a worktree. That check resolves against
 * shellDirs() alone.
 */
function resolveFrom(p, dirs) {
  const target = expandVars(p);
  if (path.isAbsolute(target)) return [target];
  return dirs.map((b) => path.join(b, target));
}

/** Where the shell is known to stand: the hook input's `cwd`, or nowhere when it is absent. */
function shellDirs(data) {
  return typeof data.cwd === 'string' && data.cwd ? [data.cwd] : [];
}

function startingDirs(data) {
  return [...new Set([...shellDirs(data), process.env.ONESHOT_WORKTREE, C.ONESHOT].filter(Boolean))];
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
    const cmd = String((data.tool_input || {}).command || '');
    // Cheap pre-filter for the name checks: nothing to do unless a protected
    // basename is mentioned at all, which is the overwhelming majority of
    // commands. Deleting a whole run directory names none, so that check runs
    // in front of it.
    const lc = cmd.toLowerCase();
    const mentionsName = [...names].some((n) => lc.includes(n));
    // Segments are walked in order so that a `cd` moves where every later
    // relative path resolves, and `cd <run> && cd artifacts && …` ends up in
    // artifacts/ rather than in both. `shell` follows the same `cd`s from the
    // real cwd only, for the one check the fallback bases would break.
    let dirs = startingDirs(data);
    let shell = shellDirs(data);
    for (const seg of segments(cmd)) {
      const c = command(seg);
      if (c.argv0 === 'cd' || c.argv0 === 'pushd') {
        dirs = chdir(dirs, c.argv0, c.rest);
        shell = chdir(shell, c.argv0, c.rest);
        continue;
      }
      for (const raw of removedPaths(c)) {
        for (const candidate of resolveFrom(raw, dirs)) {
          const hit = runDirectory(candidate);
          if (hit) refuse(hit, 'this command');
        }
      }
      if (!mentionsName) continue;

      const find = findDeletes(c, names);
      for (const root of find ? find.roots : []) {
        // A root at or above state/runs reaches that name in EVERY run. Only
        // where the shell really stands counts: against $ONESHOT_HOME, every
        // relative root is above state/runs.
        for (const candidate of resolveFrom(root, shell)) {
          if (C.isInside(runsRoot(), canonical(candidate))) {
            refuse({ iid: '*', name: find.named[0] }, 'this command');
          }
        }
        for (const candidate of resolveFrom(root, dirs)) {
          for (const n of find.named) {
            const hit = protectedArtifact(path.join(candidate, n), names);
            if (hit) refuse(hit, 'this command');
          }
        }
      }
      for (const raw of writeTargets(seg, c)) {
        for (const candidate of resolveFrom(raw, dirs)) {
          const hit = protectedArtifact(candidate, names);
          if (hit) refuse(hit, 'this command');
        }
      }
    }
    // The interpreter calls once more over the whole command, for a call whose
    // path sits on a later line than its `(` (see interpreterWrites). Absolute
    // paths only: a relative one means wherever the shell stood at that point,
    // which only the segment walk knows. Resolved against every base instead,
    // `cd artifacts && python3 -c "open('verify.json','w')"` from a shell in
    // the run directory would be refused for a file in artifacts/.
    if (mentionsName) {
      for (const raw of interpreterWrites(cmd)) {
        const target = expandVars(raw);
        if (!path.isAbsolute(target)) continue;
        const hit = protectedArtifact(target, names);
        if (hit) refuse(hit, 'this command');
      }
    }
  }
} catch (err) {
  C.logFailure('artifact-guard', err);
}

C.allow();
