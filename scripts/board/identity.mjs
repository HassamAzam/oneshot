import { hostname, userInfo, homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CFG } from './config.mjs';

/**
 * Who this desk is.
 *
 * Resolution order:
 *   1. BOARD_OPERATOR in .env — explicit, and the only one that needs no tooling
 *   2. the OS username — per-machine, always present, and needs nothing installed
 *   3. the GitHub login from `gh`, cached for a week
 *   4. unknown@hostname
 *
 * The OS username leads deliberately. The obvious candidates above it are all
 * ACCOUNT identities — the Claude Code login, the git email — and an account can
 * be shared across desks, at which point two people silently post as one and the
 * board attributes one person's work to the other. That is not a hypothetical:
 * it is what happened the first time a second desk was added here. The OS user
 * is a property of the machine, so it cannot collide that way.
 *
 * The account emails and the GitHub login are still recorded, as metadata worth
 * having; they just do not decide who you are.
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
  const email = claudeEmail();
  const git = gitEmail();
  const host = hostname();
  let osUser = '';
  try { osUser = userInfo().username; } catch { /* ignore */ }
  // Only pay for the gh lookup when it is not already settled by BOARD_OPERATOR.
  const github = explicit ? '' : cachedGithubLogin();

  const id = explicit || osUser || github || `unknown@${host}`;

  // Two ways a desk ends up posting under someone else's name, both silent:
  // a shared Claude Code login, or a git identity copied along with a cloned .env.
  // Neither is detectable from the id alone, so say so and name the one-line fix.
  // The identity itself can no longer be borrowed, but a shared account is still
  // worth flagging: it means someone's model usage is billing to another person.
  const warnings = [];
  if (!osUser && !explicit) {
    warnings.push(`could not read the OS username — identity fell back to "${id}". Set BOARD_OPERATOR in .env.`);
  }
  const local = (email || '').split('@')[0].toLowerCase();
  if (local && osUser && !local.includes(osUser.toLowerCase()) && !osUser.toLowerCase().includes(local)) {
    warnings.push(`this machine's user is "${osUser}" but Claude Code is signed in as "${email}" — `
      + 'telemetry is attributed correctly, but that account\'s usage bills to its owner.');
  }

  return {
    id,
    github_login: github || explicit || null,
    user_email: email || null,
    git_email: git || null,
    hostname: host,
    os_user: osUser || null,
    warnings,
  };
}
