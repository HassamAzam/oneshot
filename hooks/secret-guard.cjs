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
 */
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

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const input = data.tool_input || {};

  if (READ_TOOLS.has(tool)) {
    const target = expand(input.file_path || input.notebook_path || input.path || '');
    if (target && C.realish(target) === C.realish(ENV_FILE)) {
      C.event('denied_env_read', { tool, target });
      C.deny(DENIAL);
    }
  }

  if (tool === 'Bash' && typeof input.command === 'string') {
    // Resolve against the session's cwd rather than matching the string, so a
    // bare `cat .env` is judged by where it would actually land: this repo's
    // file is denied, the work repo's is the app's own business.
    const cwd = data.cwd || process.env.ONESHOT_WORKTREE || C.ONESHOT;

    for (const segment of segments(input.command)) {
      // A bare mention is not a read. `grep -rn GITLAB_TOKEN src/` is a
      // legitimate thing for a phase to do; it is the path that matters, and
      // only when the segment reads or writes it — by command or by redirect.
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
    }
  }
} catch (err) {
  C.logFailure('secret-guard', err);
}

C.allow();
