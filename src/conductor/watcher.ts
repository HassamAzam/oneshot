/**
 * The watcher: find tickets carrying the entry label and hand them to the
 * queue.
 *
 * This is the whole claim protocol. v1 needed a distributed one — post a note,
 * re-fetch, verify the newest claim is yours, roll back if not — because seven
 * peer loops could each decide they owned the same ticket. Oneshot has one
 * process and one queue, so "is this claimed" is a SQLite row.
 *
 * Every tick is a RESUMPTION, not a fresh start: a ticket with an in-flight
 * run is skipped, and a ticket whose run died mid-phase is picked up from its
 * journal rather than restarted.
 */
import { projectConfig } from '../lib/config.js';
import { isClaimed, logEvent, seeTicket } from '../lib/db.js';
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
    if (isClaimed(issue.iid)) {
      skipped.push({ iid: issue.iid, why: 'run already in flight' });
      continue;
    }
    candidates.push(issue);
  }

  return { candidates, skipped };
}

/** Human-readable one-liner for the console on every tick. */
export function describe(r: WatchResult): string {
  if (r.held) return `holding — ${r.held}`;
  if (!r.candidates.length && !r.skipped.length) return 'no tickets carry the entry label';
  const parts = [`${r.candidates.length} claimable`];
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  return parts.join(', ');
}
