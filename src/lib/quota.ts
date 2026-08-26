/**
 * Subscription quota accounting.
 *
 * Dollars are the wrong unit here. On a Max subscription the SDK's
 * total_cost_usd is computed locally from token counts at API list rates and,
 * per Anthropic, is not relevant for billing — nothing this system does
 * produces an invoice. The real constraint is the rolling 5-hour and 7-day
 * usage windows, and those are SHARED with Hassam's own interactive sessions.
 * So the job is not "spend less money", it is "leave him enough of his window".
 *
 * Raw token counts are not comparable to each other, so everything is weighted
 * into input-token-equivalents before it is measured against a ceiling.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { PAUSE_QUOTA, STATE, budgetConfig, envOr } from './config.js';
import { db, logEvent } from './db.js';
import { log } from './log.js';

export interface TokenCounts {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export function weigh(t: TokenCounts): number {
  const w = budgetConfig().weights;
  return Math.round(
    t.input * w.input +
    t.output * w.output +
    t.cache_creation * w.cache_creation +
    t.cache_read * w.cache_read,
  );
}

export function recordUsage(
  t: TokenCounts,
  meta: { runId?: string; phase?: string; model?: string },
): number {
  const weighted = weigh(t);
  db.prepare(`
    INSERT INTO quota_usage (ts, run_id, phase, model, input, output, cache_creation, cache_read, weighted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(), meta.runId ?? null, meta.phase ?? null, meta.model ?? null,
    t.input, t.output, t.cache_creation, t.cache_read, weighted,
  );
  return weighted;
}

function sumSince(sinceMs: number, where = '', params: unknown[] = []): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(weighted), 0) AS n FROM quota_usage WHERE ts >= ? ${where}`,
  ).get(sinceMs, ...params) as { n: number };
  return row.n;
}

export function windowUsage(): number {
  return sumSince(Date.now() - budgetConfig().window_hours * 3_600_000);
}

export function dayUsage(): number {
  return sumSince(Date.now() - 86_400_000);
}

export function runUsage(runId: string): number {
  return sumSince(0, 'AND run_id = ?', [runId]);
}

export function phaseUsage(runId: string, phase: string): number {
  return sumSince(0, 'AND run_id = ? AND phase = ?', [runId, phase]);
}

export interface QuotaVerdict {
  allowed: boolean;
  reason?: string;
  detail?: Record<string, number>;
}

/**
 * Account-wide window utilisation, if the status-line harvester is installed.
 *
 * The only first-party signal for how full YOUR window is (interactive
 * sessions included) is the rate_limits object Claude Code passes to an
 * interactive status line. Headless sessions never receive it, so this system
 * cannot observe it by itself. A stale reading is treated as unknown rather
 * than trusted — the file only refreshes while an interactive session is open.
 */
export function accountWindowPct(): number | null {
  const path = envOr('ONESHOT_RATELIMIT_SIGNAL',
    `${process.env.HOME ?? ''}/.claude/state/ratelimit.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      captured_at_ms?: number;
      rate_limits?: { five_hour?: { utilization?: number } };
    };
    const ageMin = (Date.now() - (raw.captured_at_ms ?? 0)) / 60_000;
    if (ageMin > budgetConfig().reserve.signal_max_age_min) return null;
    const util = raw.rate_limits?.five_hour?.utilization;
    return typeof util === 'number' ? util : null;
  } catch {
    return null;
  }
}

/** Checked before claiming a ticket and again at every phase boundary. */
export function checkQuota(runId?: string, phase?: string): QuotaVerdict {
  if (quotaParked()) return { allowed: false, reason: 'parked after a subscription usage limit' };

  const cfg = budgetConfig();
  const win = windowUsage();
  const day = dayUsage();

  if (win >= cfg.window_tokens) {
    return { allowed: false, reason: 'rolling window ceiling reached', detail: { win, cap: cfg.window_tokens } };
  }
  if (day >= cfg.day_tokens) {
    return { allowed: false, reason: 'daily ceiling reached', detail: { day, cap: cfg.day_tokens } };
  }

  const pct = accountWindowPct();
  if (pct !== null && pct >= cfg.reserve.pause_at_five_hour_pct) {
    return {
      allowed: false,
      reason: `account 5h window ${pct}% consumed — holding the reserve`,
      detail: { pct, reserve: cfg.reserve.pause_at_five_hour_pct },
    };
  }

  if (runId) {
    const used = runUsage(runId);
    if (used >= cfg.ticket_tokens) {
      return { allowed: false, reason: 'per-ticket ceiling reached', detail: { used, cap: cfg.ticket_tokens } };
    }
    if (phase) {
      const cap = cfg.phases[phase];
      if (cap !== undefined && phaseUsage(runId, phase) >= cap) {
        return {
          allowed: false,
          reason: `phase '${phase}' ceiling reached`,
          detail: { used: phaseUsage(runId, phase), cap },
        };
      }
    }
  }

  return { allowed: true };
}

// ------------------------------------------------------------- rate limiting

/**
 * Strings Claude Code emits when a SUBSCRIPTION limit is genuinely hit. These
 * are not retryable errors — the CLI blocks until the stated reset.
 *
 * Deliberately NOT matched: 529/overloaded and "temporarily limiting requests
 * (not your usage limit)". Those are transient server pressure; parking the
 * whole system for an hour over one is a self-inflicted outage.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /you've hit your (session|usage) limit/i,
  /hit the (session|weekly|opus) limit/i,
  /usage limit reached/i,
  /resets\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)/i,
  /rate[_ ]limit[_ ]error/i,
];

const NOT_A_LIMIT: RegExp[] = [
  /not your usage limit/i,
  /overloaded/i,
  /529/,
];

export function looksLikeUsageLimit(text: string): boolean {
  if (!text) return false;
  if (NOT_A_LIMIT.some((rx) => rx.test(text))) return false;
  return LIMIT_PATTERNS.some((rx) => rx.test(text));
}

/** Parse "resets 3:45pm" into an epoch ms, clamped so a misparse can't strand us. */
function parseResetMs(text: string): number | null {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? '0');
  const meridiem = (m[3] ?? '').toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/**
 * True while the machine's own quota park is in force.
 *
 * The park is self-clearing, and that self-clearing is entirely carried by
 * `until` inside the file. So a file that cannot be parsed — truncated by a
 * crash mid-write, hand-edited, or half-synced — has no expiry, and treating it
 * as a park meant the conductor stood down FOREVER while logging one ordinary
 * "parked after a subscription usage limit" line a minute. That is the worst
 * shape a failure can take here: indistinguishable from working correctly.
 *
 * A corrupt park is therefore removed and refused. Nothing is lost by doing so:
 * the weighted-token ceilings in checkQuota() are independent of this file and
 * still bound the spend, and a real limit re-parks on the next phase that hits
 * one. state/PAUSE — the human kill switch — is a different file and is never
 * touched here.
 */
export function quotaParked(): boolean {
  if (!existsSync(PAUSE_QUOTA)) return false;
  try {
    const p = JSON.parse(readFileSync(PAUSE_QUOTA, 'utf8')) as { until?: number };
    if (typeof p.until !== 'number' || !Number.isFinite(p.until)) {
      throw new Error('no usable "until" field');
    }
    if (Date.now() >= p.until) {
      rmSync(PAUSE_QUOTA, { force: true });
      logEvent('quota_park_cleared');
      log.ok('Quota park expired — resuming');
      return false;
    }
    return true;
  } catch (err) {
    log.error(`${PAUSE_QUOTA} is unreadable and has no expiry — removing it and resuming`, {
      error: (err as Error).message,
    });
    logEvent('quota_park_corrupt', { error: (err as Error).message });
    try {
      rmSync(PAUSE_QUOTA, { force: true });
    } catch (rmErr) {
      log.error('could not remove the corrupt park file — delete it by hand', {
        error: (rmErr as Error).message,
      });
    }
    return false;
  }
}

/**
 * Park after a real usage limit. Written to its own file, never state/PAUSE:
 * nothing automatic may ever create or clear the human kill switch.
 */
export function parkForQuota(text: string): void {
  const cfg = budgetConfig();
  const parsed = parseResetMs(text);
  const weekly = /weekly/i.test(text);
  const fallbackMin = weekly ? cfg.pause_defaults.weekly_minutes : cfg.pause_defaults.session_minutes;
  const until = parsed ?? Date.now() + fallbackMin * 60_000;
  // Clamp to 7 days so a mis-parsed reset time cannot strand the system.
  const clamped = Math.min(until, Date.now() + 7 * 86_400_000);

  mkdirSync(STATE, { recursive: true });
  writeFileSync(PAUSE_QUOTA, JSON.stringify({
    reason: 'subscription usage limit',
    parsed_reset: parsed,
    until: clamped,
    at: Date.now(),
  }, null, 2));
  logEvent('quota_park', { until: clamped, parsed: parsed !== null });
  log.error(`Subscription limit hit — parked until ${new Date(clamped).toLocaleTimeString()}`);
}
