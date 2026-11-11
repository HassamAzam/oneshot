#!/usr/bin/env node
'use strict';
/**
 * git credential helper for an https GitLab origin: answers `get` with the
 * token Oneshot itself acts with, and nothing else.
 *
 * Installed by scripts/setup-server.sh as
 *   credential.<https origin>.helper = <this file>
 * for the service user. git runs it as `<helper> get` with `key=value` lines on
 * stdin, and reads `username=` / `password=` back.
 *
 * WHY A FILE, AND NOT THE ENVIRONMENT. The helper this replaces was a shell
 * one-liner that echoed `$ONESHOT_GITLAB_TOKEN`. That is right for the
 * conductor, whose environment holds the token, and wrong for everything the
 * conductor starts: a phase session's environment is an allowlist
 * (src/lib/config.ts, BASE_ENV) and carries no GitLab token on purpose, so every
 * `git fetch`, `git ls-remote` and `git push` a session ran answered
 * "HTTP Basic: Access denied". On #9174 the `mr` session could not push or
 * fetch, found no GitLab tools either, and reported itself blocked. A plain
 * `sudo -u oneshot` shell failed the same way.
 *
 * Putting the token INTO the session environment would have fixed git and
 * handed every session a credential it can print, paste into curl and use past
 * the tool policy. So the token stays where it already is — this checkout's
 * `.env`, mode 600 — and only git's own child process reads it, at the moment
 * git asks. The environment still wins when it has the token (the conductor),
 * so nothing changes for the caller that already worked.
 *
 * It answers for ONE host: the one GITLAB_REPO_URL names. git only consults a
 * URL-scoped helper for a matching URL, and this checks again, so a remote
 * pointed anywhere else gets no token from here. `store` and `erase` are
 * no-ops: there is nothing to save, and a rejected token is the operator's to
 * replace in `.env`.
 *
 * hooks/git-guard.cjs refuses `git credential …` and a direct run of this file
 * from a phase session, which are the two ways to make it print to a transcript.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** `key=value` lines, as git writes them to a helper. Unknown keys are kept and ignored. */
function parseRequest(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The first non-empty value of `key`: the process environment, then the env file. */
function setting(key, env, fileEnv) {
  const fromEnv = env[key];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = fileEnv[key];
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : '';
}

/**
 * What to answer for one request, or null to answer nothing.
 *
 * Pure: the caller supplies the request, the environment and the parsed env
 * file. Null for anything that is not an https `get` for the configured GitLab
 * host, and when no token is configured — git then reports that it has no
 * credential, which is the truth.
 */
function answer(op, request, env, fileEnv) {
  if (op !== 'get') return null;
  if (request.protocol !== 'https' || !request.host) return null;
  const repoUrl = setting('GITLAB_REPO_URL', env, fileEnv);
  let host = '';
  try { host = new URL(repoUrl).host; } catch { return null; }
  if (!host || request.host.toLowerCase() !== host.toLowerCase()) return null;
  // Same precedence as src/lib/token.ts for the two names an env file can carry.
  const token = setting('ONESHOT_GITLAB_TOKEN', env, fileEnv) || setting('GITLAB_TOKEN', env, fileEnv);
  if (!token) return null;
  return { username: 'oauth2', password: token };
}

function readEnvFile(file) {
  try {
    const { parseEnvText } = require(path.join(ROOT, 'src/lib/appenv.cjs'));
    return parseEnvText(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // no file, or unreadable: the environment is all there is
  }
}

function main(argv) {
  const op = argv[0];
  if (op !== 'get') return 0;
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin: nothing to answer */ }
  const a = answer(op, parseRequest(input), process.env, readEnvFile(path.join(ROOT, '.env')));
  if (a) process.stdout.write(`username=${a.username}\npassword=${a.password}\n`);
  return 0;
}

module.exports = { answer, parseRequest };

if (require.main === module) process.exit(main(process.argv.slice(2)));
