/**
 * Who this desk is. The answer is its GitLab token.
 *
 * THE PROBLEM
 * -----------
 * The assignee gate decides which tickets to claim by comparing a ticket's
 * assignees against a username, while every action — the claim note, the branch,
 * the merge request, the merge, every ticket comment — is performed by whoever
 * owns the GitLab token. Those were two separate facts and nothing compared them,
 * so a desk could work one person's tickets and speak as another. It also meant
 * the acting identity could be a real human on config/reviewers.json: run 29's
 * plan gate read another conductor's claim note as reviewer feedback and
 * re-planned three times into a quota wall.
 *
 * THE MODEL
 * ---------
 * There is only one fact now. The token both selects and acts, so they cannot
 * disagree:
 *
 *     this desk's token  --GET /user-->  this desk's username
 *
 * src/lib/token.ts resolves that token from the operator's own machine, so the
 * conductor acts as the person sitting at it. Nothing here reads a username out
 * of configuration.
 *
 * THE CLAUDE ACCOUNT IS A SECOND OPINION, NOT THE IDENTITY
 * -------------------------------------------------------
 * ~/.claude.json says who is signed into Claude Code at this desk. It is read
 * for exactly one purpose: telling "my own token" apart from "a colleague's
 * token I inherited by copying their .env". Both look identical to the token
 * resolver, and only one of them is a mistake. It never decides who the desk is.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveToken, SETUP_HINT, type ResolvedToken } from './token.js';

/**
 * Deliberately not imported from ./config.js. config.ts consumes this module to
 * resolve GITLAB_USERNAME, and a cycle between them would leave whichever loaded
 * first holding an undefined binding. The read is one line; the cycle is a bug
 * waiting for a refactor to expose it.
 */
const envOr = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;

/**
 * Read the account Claude Code is signed in as.
 *
 * Deliberately tolerant: a missing or malformed file is a desk that has not run
 * `claude login` yet, which the doctor should report as a setup step rather than
 * a crash on the conductor's first tick.
 */
export function claudeAccountEmail(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8');
    const email = JSON.parse(raw)?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

/**
 * The GitLab username for a signed-in address.
 *
 * Local part only. `hassam.azam@arbisoft.com` -> `hassam.azam`. Any `+tag`
 * suffix is dropped, since an address that routes to the same inbox is still
 * the same person.
 */
export function usernameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return (local.split('+')[0] ?? '').trim().toLowerCase();
}

export interface TokenIdentity {
  username: string;
  name?: string;
  /** True when GitLab reports this account as a bot (project/group access token). */
  bot: boolean;
  /** Which credential answered, and where a human changes it. */
  source: ResolvedToken;
}

/**
 * Ask GitLab who `GITLAB_TOKEN` actually is.
 *
 * Kept here rather than in gitlab.ts because it asks about the CALLER, not about
 * the project, and because it must work before the circuit breaker and the
 * project config are meaningful — the doctor calls it on a machine that may have
 * nothing else set up correctly yet.
 *
 * Returns null on any failure. A desk that cannot reach GitLab has a network
 * problem to report, not an identity problem, and conflating the two sent runs
 * to a human label for a VPN that was merely down.
 */
export async function tokenIdentity(): Promise<TokenIdentity | null> {
  const resolved = resolveToken();
  if (!resolved.token) return null;
  const apiUrl = envOr('ONESHOT_GITLAB_API') || 'https://gitlab.arbisoft.com/api/v4';
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(`${apiUrl}/user`, {
      headers: { 'PRIVATE-TOKEN': resolved.token },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const u = await res.json() as { username?: string; name?: string; bot?: boolean };
    if (!u?.username) return null;
    return { username: u.username, name: u.name, bot: u.bot === true, source: resolved };
  } catch {
    return null;
  } finally {
    clearTimeout(killer);
  }
}

/**
 * The desk's username, resolved once and remembered.
 *
 * The assignee gate runs on every scan and cannot make a network call each time,
 * so index.ts resolves this at boot (via checkIdentity) and the watcher reads the
 * cached answer. Empty before boot has resolved it, which is the same "skip every
 * assigned ticket" behaviour as an unidentified desk — correct, because a desk
 * that does not yet know who it is must not claim anybody's work.
 */
let cachedUsername = '';
export function deskUsername(): string { return cachedUsername; }

export interface IdentityCheck {
  /** The username this desk acts and selects as. Empty when no token resolved. */
  username: string;
  token: TokenIdentity | null;
  /** The Claude account on this machine, for the mismatch warning only. */
  claudeUsername: string | null;
  warning: string | null;
}

/**
 * Resolve who this desk is, from its own token.
 *
 * The token IS the identity. There is no second fact to keep in sync, so the
 * class of bug where a desk selects one person's tickets and acts as another
 * cannot occur — the same credential does both.
 *
 * The Claude account is still read, but only to warn: a desk holding Hassam's
 * GitLab token while signed into Claude as someone else is burning one person's
 * subscription to act as another, which HANDOFF.md already warns about and which
 * nothing detected until now.
 */
export async function checkIdentity(): Promise<IdentityCheck> {
  const token = await tokenIdentity();
  const email = claudeAccountEmail();
  const claudeUsername = email ? usernameFromEmail(email) : null;
  let warning: string | null = null;

  if (!token) {
    const resolved = resolveToken();
    warning = resolved.token
      ? `A token was found in ${resolved.where}, but GitLab did not accept it or could not be `
        + 'reached. Assigned tickets will be skipped until it answers.'
      : `This desk has no GitLab token, so it has no identity and will skip every ASSIGNED `
        + `ticket.\n${SETUP_HINT}`;
  } else {
    cachedUsername = token.username;
    // A token in .env is only a PROBLEM when it is not this operator's own. The
    // Claude account is the second opinion that tells those apart: if the .env
    // token acts as the person signed in at this desk, it IS their own token and
    // there is nothing to warn about — nagging them would train the warning out.
    // The remaining note is about WHERE it lives, not whose it is: a phase has
    // already read .env and leaked its contents into a shipped transcript, so a
    // personal credential is safer outside the repo.
    const ownTokenInEnv = token.source.shared && claudeUsername === token.username;
    if (token.source.shared && !ownTokenInEnv && !token.bot) {
      warning = `Acting as "${token.username}" using the token in this repo's .env, but this desk is `
        + `signed into Claude as "${claudeUsername ?? 'nobody'}". That is somebody else's credential `
        + `doing your work: it will claim ${token.username}'s tickets and comment, push and merge as `
        + `them.\n${SETUP_HINT}`;
    } else if (ownTokenInEnv) {
      warning = `Your own token works fine where it is. Note only that .env has leaked into a run `
        + 'transcript before; ~/.config/oneshot/gitlab-token is outside every repo. '
        + '`npm run token:set` moves it.';
    } else if (claudeUsername && !token.bot && claudeUsername !== token.username) {
      warning = `This desk acts on GitLab as "${token.username}" but is signed into Claude as `
        + `"${claudeUsername}" — one person's subscription paying for another's work. `
        + 'Check `claude login` and ~/.config/oneshot/gitlab-token belong to the same person.';
    }
  }
  return { username: token?.username ?? '', token, claudeUsername, warning };
}

/** One line for the boot banner. Never prints an email or a token. */
export function describeIdentity(c: IdentityCheck): string {
  if (!c.token) return 'identity   unresolved — no usable GitLab token, assigned tickets skipped';
  const kind = c.token.bot ? 'bot' : 'user';
  return `identity   ${c.token.username} (${kind}, token from ${c.token.source.where})`;
}
