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
 * runs as its owner, so `cat`, `grep`, a Read tool call or a heredoc-free
 * `sed -n` all reach it, and everything a phase prints goes into a transcript
 * that outlives the run. This closes that, and nothing else — a guard that
 * tried to catch every way a secret could be echoed would be a guard nobody
 * could reason about.
 *
 * Scoped to this repo's own .env. A work repo's .env belongs to the app the
 * phase is there to run, and blocking it would break bringing that app up.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const ENV_FILE = path.join(C.ONESHOT, '.env');

const DENIAL =
  `Denied: ${ENV_FILE} holds this machine's credentials, and everything a phase prints ` +
  'lands in a transcript that outlives the run.\n' +
  'Nothing here needs it: the session environment is a whitelist, so the token is not in ' +
  'your environment either — it goes straight to the GitLab MCP server, which is how the ' +
  'mcp__gitlab__* tools are already authenticated for you. Use those tools.\n' +
  'If something genuinely cannot proceed without a credential, report that in `blocked`; ' +
  'an operator resolves it, not you.';

/** Split a command line on the separators a shell treats as a new command. */
function segments(command) {
  return command.split(/(?:\|\||&&|[;|\n])/g).map((s) => s.trim()).filter(Boolean);
}

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const input = data.tool_input || {};

  if (READ_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || '';
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
    const READER = /^\s*(cat|bat|less|more|head|tail|grep|egrep|rg|awk|sed|cut|sort|strings|xxd|od|open|cp|scp|rsync|source|\.)\b/;

    for (const segment of segments(input.command)) {
      // A bare mention is not a read. `grep -rn GITLAB_TOKEN src/` is a
      // legitimate thing for a phase to do; it is the path that matters.
      const paths = segment.match(/[^\s'"<>|]*\.env\b/g) || [];
      if (!paths.length) continue;
      if (!READER.test(segment) && !/<\s*[^\s]*\.env\b/.test(segment)) continue;

      for (const candidate of paths) {
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
