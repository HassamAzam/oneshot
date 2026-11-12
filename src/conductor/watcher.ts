/**
 * The watcher: find tickets carrying the entry label and hand them to the
 * queue.
 *
 * "Is this claimed" has two halves. On this machine it is a SQLite row. Across
 * machines it is the ticket's own comments — the OLDEST live claim note owns
 * the ticket (lib/claims.ts). v1 needed exactly that distributed protocol and
 * it was dropped when Oneshot became one process; it came back the day a
 * second laptop ran a conductor against the same board and both sides passed
 * their local row.
 *
 * Every tick is a RESUMPTION, not a fresh start: a ticket with an in-flight
 * run is skipped, and a ticket whose run died mid-phase is picked up from its
 * journal rather than restarted.
 */
import {
  DRY_RUN, MERGE_POLL_MS, gitlabUsername, handoffAtMerge, pickupAnyAssignee, pickupLabel, pickupOnly, pickupSince,
  projectConfig,
} from '../lib/config.js';
import { readJournal, type RunJournal } from '../lib/artifacts.js';
import { foreignOwner } from '../lib/claims.js';
import { isClaimed, latestRunStatus, logEvent, seeTicket } from '../lib/db.js';
import { issuesWithEntryLabel, labelAddedAt, type Issue } from '../lib/gitlab.js';
import { isReachable, netState } from '../lib/reachability.js';
import { checkQuota } from '../lib/quota.js';
import { log } from '../lib/log.js';

export interface WatchResult {
  candidates: Issue[];
  skipped: Array<{ iid: number; why: string }>;
  held?: string;
}

/**
 * One scan. Returns what is claimable right now and why everything else was
 * passed over — the "why" matters, because a queue that silently drops work
 * looks identical to a queue with nothing to do.
 */
export async function scan(): Promise<WatchResult> {
  if (!isReachable()) {
    return { candidates: [], skipped: [], held: `network ${netState()}` };
  }

  const quota = checkQuota();
  if (!quota.allowed) {
    return { candidates: [], skipped: [], held: `quota: ${quota.reason}` };
  }

  const res = await issuesWithEntryLabel();
  if (!res.ok || !res.data) {
    // Classification matters: an auth failure is a config problem the operator
    // must fix, not something to retry against forever.
    if (res.kind === 'auth') {
      log.error('GitLab refused the token — check GITLAB_TOKEN scope (needs api)', {
        status: res.status,
      });
    }
    logEvent('scan_failed', { kind: res.kind, status: res.status });
    return { candidates: [], skipped: [], held: `gitlab ${res.kind}` };
  }

  return triage(res.data);
}

/**
 * How long a run parked on a human merge has before its next merge check, or
 * null when it is due (or is not that kind of park). The same window
 * `mergePollWait` applies inside runTicket, read here so a run that would only
 * claim the slot, find nothing due and park again is never handed the slot: with
 * one slot free, that re-check took it every tick and a ticket behind it whose
 * plan had been approved never started.
 */
export function mergeWaitRemaining(j: RunJournal | null, status: string | null, now: number): number | null {
  if (!j || status !== 'parked' || !j.reviewMode || DRY_RUN || handoffAtMerge()) return null;
  if (typeof j.humanMergeCheckAt !== 'number') return null;
  if (j.phases.some((p) => p.phase === 'merge' && p.status === 'ok')) return null;
  const left = j.humanMergeCheckAt + MERGE_POLL_MS - now;
  return left > 0 ? left : null;
}

/**
 * When the entry label was last added, per ticket, kept while the ticket's
 * `updated_at` is unchanged: a label change moves `updated_at`, so the history
 * is re-read exactly when the answer could differ, not for every ticket on every
 * tick. Undefined when GitLab could not be read.
 */
const labelAdds = new Map<number, { updatedAt: string; at: number | null }>();

async function entryLabelAddedAt(issue: Issue, label: string): Promise<number | null | undefined> {
  const hit = labelAdds.get(issue.iid);
  if (hit && hit.updatedAt === issue.updated_at) return hit.at;
  const res = await labelAddedAt(issue.iid, label);
  if (!res.ok) return undefined;
  labelAdds.set(issue.iid, { updatedAt: issue.updated_at, at: res.data });
  return res.data;
}

/**
 * The scan's verdict on each ticket it read: claimable, skipped with a reason,
 * or dropped silently (a teammate's). Split from scan() only so a test can
 * hand it tickets without the network and quota gates in front; scan() is
 * those gates, one read, and this.
 */
export async function triage(issues: Issue[]): Promise<WatchResult> {
  const cfg = projectConfig();
  const anyAssignee = pickupAnyAssignee();
  const only = pickupOnly();
  const since = pickupSince();
  const required = pickupLabel();
  const candidates: Issue[] = [];
  const skipped: Array<{ iid: number; why: string }> = [];

  for (const issue of issues) {
    seeTicket(issue.iid, issue.title, issue.labels);
    // Outside ONESHOT_PICKUP_ONLY, dropped silently like a teammate's ticket: one
    // skip line per ticket on the board every tick would bury the listed ones.
    if (only && !only.has(issue.iid)) continue;
    // Without ONESHOT_PICKUP_LABEL the ticket is not this conductor's board:
    // dropped silently for the same reason.
    if (required && !issue.labels.includes(required)) continue;

    if (issue.labels.includes(cfg.labels.exit)) {
      skipped.push({ iid: issue.iid, why: `already ${cfg.labels.exit}` });
      continue;
    }
    if (issue.labels.includes(cfg.labels.blocked)) {
      // A human has to look at it and take the label off. Re-claiming it would
      // just reproduce whatever blocked it the first time.
      skipped.push({ iid: issue.iid, why: `carries ${cfg.labels.blocked}` });
      continue;
    }
    if (since !== null && !readJournal(issue.iid)) {
      const added = await entryLabelAddedAt(issue, cfg.labels.entry);
      if (added === undefined) {
        skipped.push({ iid: issue.iid, why: `could not read when ${cfg.labels.entry} was added` });
        continue;
      }
      // Labelled before ONESHOT_PICKUP_SINCE: one of the board's stale tickets.
      // Dropped silently, like a teammate's — dozens of them would bury the rest.
      if (added === null || added < since) continue;
    }
    if (!anyAssignee && issue.assignees.length > 0) {
      // Resolved at boot from this desk's own token, so the account that claims
      // the ticket is the same account that will comment, push and merge on it.
      const me = gitlabUsername();
      if (!me) {
        skipped.push({ iid: issue.iid, why: 'assigned ticket, but this desk has no GitLab identity (npm run token:set)' });
        continue;
      }
      if (!issue.assignees.some((a) => a.username === me)) {
        // Assigned to a teammate — not this desk's board at all. It is neither
        // claimable here nor a skip worth reporting, so it is dropped silently
        // rather than pushed to `skipped`: one line per teammate's ticket every
        // tick buried this desk's own tickets in noise.
        continue;
      }
    }
    if (isClaimed(issue.iid)) {
      skipped.push({ iid: issue.iid, why: 'run already in flight' });
      continue;
    }
    const mergeWait = mergeWaitRemaining(readJournal(issue.iid), latestRunStatus(issue.iid), Date.now());
    if (mergeWait !== null) {
      skipped.push({ iid: issue.iid, why: `waiting on a human merge — next check in ${Math.ceil(mergeWait / 60_000)}m` });
      continue;
    }
    // The other machine's claim. This has to be a scan-time skip and not only a
    // claim-time refusal: with one slot, a foreign-owned ticket at the head of
    // the list would be attempted and refused every tick and nothing behind it
    // would ever be tried. One notes read per surviving candidate per tick.
    const foreign = await foreignOwner(issue.iid, { evenStale: anyAssignee });
    if (foreign) {
      skipped.push({
        iid: issue.iid,
        why: `claimed by another conductor — run ${foreign.runId}${foreign.author ? ` (${foreign.author})` : ''}`,
      });
      continue;
    }
    candidates.push(issue);
  }

  return { candidates: orderCandidates(candidates, latestRunStatus), skipped };
}

/**
 * Latest-run statuses that mean a ticket is waiting on a PERSON, not on capacity:
 * a plan/qa PARK waiting for an `approved` comment, or a BLOCK waiting for someone
 * to clear it. Such a ticket stays claimable on purpose — a park is resumed by
 * re-claiming it and re-reading its gate — but it makes no forward progress until
 * the human acts.
 */
const STALLED_STATUSES = new Set(['parked', 'blocked']);

/**
 * Order candidates so fresh and resumable work is dispatched before human-stalled
 * work, without dropping the stalled tickets.
 *
 * The dispatcher fills its one slot from the HEAD of this list (src/index.ts,
 * `candidates.slice(0, slots)`). A parked ticket is re-offered every tick — a
 * park is not an "active" run, so nothing filters it out — and sorted by
 * updated_at it can sit at the head indefinitely, where every conductor keeps
 * re-claiming and re-parking it and no fresh ticket behind it is ever reached.
 * One ticket parked on plan approval did exactly that to the two queued behind
 * it, and adding conductors did not help: they all piled onto the same head.
 *
 * A stable partition — ready first, stalled last, original order preserved within
 * each half — fixes it while keeping a parked ticket claimable: it is still tried
 * once the ready work ahead of it is in flight, so an approved plan is still
 * picked up on a later tick.
 */
export function orderCandidates(
  candidates: Issue[],
  statusOf: (iid: number) => string | null,
): Issue[] {
  const ready: Issue[] = [];
  const stalled: Issue[] = [];
  for (const issue of candidates) {
    if (STALLED_STATUSES.has(statusOf(issue.iid) ?? '')) stalled.push(issue);
    else ready.push(issue);
  }
  return [...ready, ...stalled];
}

/** Human-readable one-liner for the console on every tick. */
export function describe(r: WatchResult): string {
  if (r.held) return `holding — ${r.held}`;
  if (!r.candidates.length && !r.skipped.length) return 'no tickets carry the entry label';
  const parts = [`${r.candidates.length} claimable`];
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  return parts.join(', ');
}
