import { hostname, userInfo, homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CFG } from './config.mjs';

/**
 * Who this desk is, as a GitHub username.
 *
 * Resolution order:
 *   1. BOARD_OPERATOR in .env — explicit, and the only one that needs no tooling
 *   2. `gh api user` — the authenticated GitHub login, cached for a week
 *   3. `git config github.user`
 *   4. Claude Code's authenticated account email (~/.claude.json)
 *   5. git config user.email
 *   6. os_user@hostname
 *
 * The gh lookup is a network call, so its answer is cached: a laptop on a slow
 * VPN must not pay for it on every scan, and must still report an identity when
 * GitHub is unreachable.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

function cachedGithubLogin() {
  const file = join(CFG.stateDir, 'identity.json');
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c.github_login && Date.now() - (c.at ?? 0) < CACHE_TTL_MS) return c.github_login;
  } catch { /* no cache yet, or unreadable */ }

  let login = '';
  try {
    login = execFileSync('gh', ['api', 'user', '--jq', '.login'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  } catch { /* gh missing, not logged in, or offline */ }
  if (!login) {
    try {
      login = execFileSync('git', ['config', 'github.user'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* unset */ }
  }
  if (login) {
    try {
      mkdirSync(CFG.stateDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ github_login: login, at: Date.now() }));
    } catch { /* cache is an optimisation, never a requirement */ }
  } else {
    // Serve a stale cache rather than losing the identity when GitHub is unreachable.
    try { return JSON.parse(readFileSync(file, 'utf8')).github_login || ''; } catch { /* none */ }
  }
  return login;
}

function claudeEmail() {
  try {
    return String(JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? '');
  } catch { return ''; }
}

function gitEmail() {
  for (const args of [['-C', CFG.oneshotHome, 'config', 'user.email'], ['config', '--global', 'user.email']]) {
    try {
      const v = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (v) return v;
    } catch { /* no git, or unset */ }
  }
  return '';
}

export function resolveOperator() {
  const explicit = CFG.operator;
  const github = explicit || cachedGithubLogin();
  const email = claudeEmail();
  const git = gitEmail();
  const host = hostname();
  let osUser = '';
  try { osUser = userInfo().username; } catch { /* ignore */ }

  const id = github || email || git || `${osUser || 'unknown'}@${host}`;
  return {
    id,
    github_login: github || null,
    user_email: email || null,
    git_email: git || null,
    hostname: host,
    os_user: osUser || null,
  };
}
