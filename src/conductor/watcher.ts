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
import { gitlabUsername, projectConfig } from '../lib/config.js';
import { foreignOwner } from '../lib/claims.js';
import { isClaimed, latestRunStatus, logEvent, seeTicket } from '../lib/db.js';
import { issuesWithEntryLabel, type Issue } from '../lib/gitlab.js';
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
  const cfg = projectConfig();

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

  const candidates: Issue[] = [];
  const skipped: Array<{ iid: number; why: string }> = [];

  for (const issue of res.data) {
    seeTicket(issue.iid, issue.title, issue.labels);

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
    if (issue.assignees.length > 0) {
      // Resolved at boot from this desk's own token, so the account that claims
      // the ticket is the same account that will comment, push and merge on it.
      const me = gitlabUsername();
      if (!me) {
        skipped.push({ iid: issue.iid, why: 'assigned ticket, but this desk has no GitLab identity (npm run token:set)' });
        continue;
      }
      if (!issue.assignees.some((a) => a.username === me)) {
        skipped.push({ iid: issue.iid, why: `assigned to ${issue.assignees.map((a) => a.username).join(', ')}` });
        continue;
      }
    }
    if (isClaimed(issue.iid)) {
      skipped.push({ iid: issue.iid, why: 'run already in flight' });
      continue;
    }
    // The other machine's claim. This has to be a scan-time skip and not only a
    // claim-time refusal: with one slot, a foreign-owned ticket at the head of
    // the list would be attempted and refused every tick and nothing behind it
    // would ever be tried. One notes read per surviving candidate per tick.
    const foreign = await foreignOwner(issue.iid);
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
 * #87 parked on plan approval did exactly that to #235 and #237, and adding
 * conductors did not help because they all piled onto the same head ticket.
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
