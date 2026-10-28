/**
 * The escaped-defect sweep, wired to GitLab and to the conductor's clock.
 *
 * Separate from lib/escapecollect.ts so the decision logic stays testable with
 * no network: this file is only the reader and the throttle.
 */
import { issueLabelEvents } from '../lib/gitlab.js';
import { collectEscapes, escapeLine, type EscapeRow, type LabelEventReader } from '../lib/escapecollect.js';
import { escapeRate } from '../lib/escapes.js';
import { log } from '../lib/log.js';

/**
 * Board labels move on human timescales — erp#8781 sat two days between merge
 * and sign-off — so sweeping on every conductor tick would re-read the same
 * unchanged history dozens of times an hour for no new information, and spend
 * the rate limit that the actual runs need.
 */
export const SWEEP_EVERY_MS = 30 * 60 * 1000;

let lastSweptAt = 0;

/** Read a ticket's label history, shaping a GitLab failure into a reason. */
export const gitlabLabelEvents: LabelEventReader = async (iid) => {
  const res = await issueLabelEvents(iid);
  if (!res.ok || !res.data) {
    return { ok: false, error: `${res.kind}${res.status ? ` ${res.status}` : ''}: ${(res.error ?? '').slice(0, 80)}` };
  }
  return {
    ok: true,
    events: res.data
      .filter((e) => e.label?.name && e.created_at)
      .map((e) => ({
        at: Date.parse(e.created_at!),
        action: e.action,
        label: e.label!.name,
        by: e.user?.username ?? null,
      })),
  };
};

/**
 * One sweep. Returns the rows, or null when the throttle declined.
 *
 * NEVER THROWS. This is a measurement riding along with the conductor; a
 * GitLab outage or a bad journal must not take down the loop that is doing the
 * actual work. Every failure is logged and the sweep returns what it has.
 */
export async function sweepEscapes(opts: { force?: boolean } = {}): Promise<EscapeRow[] | null> {
  const now = Date.now();
  if (!opts.force && now - lastSweptAt < SWEEP_EVERY_MS) return null;
  lastSweptAt = now;
  try {
    const rows = await collectEscapes(gitlabLabelEvents);
    if (!rows.length) return rows;

    const readable = rows.filter((r) => r.record).map((r) => r.record!);
    const unreadable = rows.filter((r) => r.error);
    const rate = escapeRate(readable);

    // Unreadable tickets are reported in the same breath as the rate, because
    // they are the one thing that makes the rate a lie — an access failure
    // looks exactly like a ticket nobody filed a bug against.
    log.info('escaped-defect sweep', {
      shipped: rows.length,
      settled: rate.settled,
      escaped: rate.escaped,
      rate: rate.rate === null ? 'too few to rate' : `${Math.round(rate.rate * 100)}%`,
      // Every category the rate leaves out, reported with it. A rate whose
      // denominator silently shrinks is the failure this eval exists to avoid,
      // so the exclusions travel beside the number rather than behind it.
      ...(rate.open ? { open: rate.open } : {}),
      ...(rate.indeterminate ? { indeterminate: rate.indeterminate } : {}),
      ...(rate.notShipped ? { noMergeOnBoard: rate.notShipped } : {}),
      ...(unreadable.length ? { unreadable: unreadable.length } : {}),
    });
    for (const r of unreadable) log.warn(escapeLine(r));
    return rows;
  } catch (e) {
    log.warn('escaped-defect sweep failed — the loop is unaffected', {
      error: (e as Error)?.message?.slice(0, 160) ?? String(e),
    });
    return [];
  }
}

/** Kicked, not awaited: a measurement must never delay a claim. */
export function kickEscapeSweep(): void {
  void sweepEscapes().catch(() => { /* sweepEscapes already swallows; this is belt and braces */ });
}
