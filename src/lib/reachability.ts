/**
 * GitLab circuit breaker.
 *
 * GitLab and the demo box both live behind FortiClient, and that tunnel drops.
 * Without a breaker, a dropped VPN is the most expensive thing this system can
 * do: every phase burns its full wall-clock timeout on calls that cannot
 * succeed, and the subscription window goes with it.
 *
 * Three states, not two. ok -> degraded after 2 consecutive failures ->
 * recovering on the first success -> ok only after 2 consecutive successes.
 * `recovering` is what stops a 5-second blip from flapping the system and the
 * Slack channel.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { PAUSE_NETWORK, STATE, deployConfig } from './config.js';
import { logEvent } from './db.js';
import { log } from './log.js';
import { ping } from './gitlab.js';

export type NetState = 'ok' | 'degraded' | 'recovering';

const FAILS_TO_TRIP = 2;
const SUCCESSES_TO_CLEAR = 2;

/** 30s, 60s, 120s, 300s — a long outage must not become a busy loop. */
const BACKOFF_LADDER_MS = [30_000, 60_000, 120_000, 300_000];

let state: NetState = 'ok';
let consecutiveFails = 0;
let consecutiveOks = 0;
let backoffIndex = 0;
let degradedSince = 0;

export function netState(): NetState { return state; }

export function nextProbeDelayMs(): number {
  if (state === 'ok') return 0;
  return BACKOFF_LADDER_MS[Math.min(backoffIndex, BACKOFF_LADDER_MS.length - 1)]!;
}

function writePause(): void {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(PAUSE_NETWORK, JSON.stringify({
    reason: 'gitlab unreachable',
    since: degradedSince,
    checked_at: Date.now(),
  }, null, 2));
}

/** Re-stamp so hooks can tell a live outage from a supervisor killed mid-outage. */
function touchPause(): void {
  if (!existsSync(PAUSE_NETWORK)) return writePause();
  try {
    const cur = JSON.parse(readFileSync(PAUSE_NETWORK, 'utf8')) as Record<string, unknown>;
    cur.checked_at = Date.now();
    writeFileSync(PAUSE_NETWORK, JSON.stringify(cur, null, 2));
  } catch { writePause(); }
}

function clearPause(): void {
  try { rmSync(PAUSE_NETWORK, { force: true }); } catch { /* already gone */ }
}

export interface ProbeOutcome {
  state: NetState;
  changed: boolean;
  downtimeMs: number;
}

/**
 * One probe. Returns whether the state changed, so exactly one message is
 * posted on the way down and one on the way up — the caller owns alerting,
 * because two processes both alerting is how you get duplicate pages.
 */
export async function probe(): Promise<ProbeOutcome> {
  const res = await ping();

  // 401/403 means the server answered: a bad token is an auth problem, not an
  // outage, and treating it as one makes a wrong PAT look permanent.
  const isDown = res.kind === 'network' || res.kind === 'server';
  const previous = state;

  if (isDown) {
    consecutiveOks = 0;
    consecutiveFails += 1;
    if (state === 'ok' && consecutiveFails >= FAILS_TO_TRIP) {
      state = 'degraded';
      degradedSince = Date.now();
      backoffIndex = 0;
      writePause();
      logEvent('network_degraded', { status: res.status, error: res.error });
      log.error('GitLab unreachable — network breaker OPEN', { kind: res.kind });
    } else if (state !== 'ok') {
      state = 'degraded';
      backoffIndex = Math.min(backoffIndex + 1, BACKOFF_LADDER_MS.length - 1);
      touchPause();
    }
  } else {
    consecutiveFails = 0;
    consecutiveOks += 1;
    if (state === 'degraded') {
      state = 'recovering';
      backoffIndex = 0;
      touchPause();
    } else if (state === 'recovering' && consecutiveOks >= SUCCESSES_TO_CLEAR) {
      state = 'ok';
      clearPause();
      const downtime = degradedSince ? Date.now() - degradedSince : 0;
      logEvent('network_recovered', { downtimeMs: downtime });
      log.ok(`GitLab reachable again after ${Math.round(downtime / 1000)}s`);
      degradedSince = 0;
    }
  }

  return {
    state,
    changed: state !== previous,
    downtimeMs: degradedSince ? Date.now() - degradedSince : 0,
  };
}

/** True when work may proceed. `recovering` deliberately does NOT dispatch. */
export function isReachable(): boolean { return state === 'ok'; }

/**
 * The demo box is on the same VPN-gated subnet as GitLab but is a separate
 * host, so a GitLab-only probe can report `ok` while a deploy would hang for
 * its full 50-minute budget. Phase 10 calls this before invoking the script.
 */
export async function demoHostReachable(): Promise<boolean> {
  const cfg = deployConfig();
  const host = cfg.server.includes('@') ? cfg.server.split('@')[1] : cfg.server;
  if (!host) return false;
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('ssh', [
    '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    cfg.server, 'echo ok',
  ], { encoding: 'utf8', timeout: 25_000 });
  return res.status === 0 && res.stdout.trim() === 'ok';
}
