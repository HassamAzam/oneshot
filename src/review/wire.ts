/**
 * The only file in src/review that touches src/lib. Everything else here is
 * pure and unit-tested; this builds the real GitLab and file dependencies
 * around it — the same split src/mrfeedback/wire.ts makes, for the same reason.
 */
import { DRY_RUN, envOr } from '../lib/config.js';
import { readArtifact, writeArtifact } from '../lib/artifacts.js';
import {
  allMrDiscussions, createMrDiscussion, getMergeRequest, mergeRequestDiffs, replyToMrDiscussion,
  setMrDiscussionResolved, type GitlabResult, type MrDiff,
} from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import { liveOpenThreads } from './ledger.js';
import { diffLineFor } from './position.js';
import type { ReviewApi, ReviewLedger } from './types.js';

/** The loop's own state, beside the phase artifacts. Conductor-owned: hooks/artifact-guard.cjs keeps sessions off it. */
export const REVIEW_LEDGER = 'review-threads.json';

/**
 * Whether the review runs as threads on the merge request.
 *
 * On unless switched off: ONESHOT_REVIEW_THREADS=0 puts a desk back on the old
 * loop (review cycles to implement, merge reads findings.json) without a
 * redeploy, which is the way out if the new loop misbehaves in the field. Off
 * under DRY_RUN, because a dry run posts nothing and the loop is made of posts.
 * A run still needs a merge request to post on; the caller checks that.
 */
export function reviewThreadsEnabled(): boolean {
  return envOr('ONESHOT_REVIEW_THREADS', '1') !== '0' && !DRY_RUN;
}

export function readReviewLedger(iid: number): ReviewLedger | null {
  const l = readArtifact<ReviewLedger>(iid, REVIEW_LEDGER);
  return l && l.version === 1 && Array.isArray(l.threads) && Array.isArray(l.pending) ? l : null;
}

export function writeReviewLedger(iid: number, l: ReviewLedger): void {
  writeArtifact(iid, REVIEW_LEDGER, l);
}

const gone = (res: GitlabResult<unknown>): boolean => res.kind === 'notfound';

/** GitLab, as the loop needs it, for one merge request. */
export function reviewApiFor(mrIid: number): ReviewApi {
  // Read once per API object: the diff does not change between the threads of one flush.
  let diffs: Promise<MrDiff[] | null> | null = null;
  const diffFiles = (): Promise<MrDiff[] | null> => {
    diffs ??= mergeRequestDiffs(mrIid).then((r) => (r.ok && r.data ? r.data.files : null));
    return diffs;
  };

  return {
    async discussions() {
      const res = await allMrDiscussions(mrIid);
      return res.ok && res.data ? res.data : null;
    },

    async createThread(at, body) {
      const [mr, files] = await Promise.all([getMergeRequest(mrIid), diffFiles()]);
      const refs = mr.ok ? mr.data?.diff_refs ?? null : null;
      const where = refs && files ? diffLineFor(files, at.file, at.line) : null;
      if (refs && where) {
        const pinned = await createMrDiscussion(mrIid, body(true), {
          baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha,
          oldPath: where.oldPath, newPath: where.newPath, newLine: where.newLine,
          ...(where.oldLine === undefined ? {} : { oldLine: where.oldLine }),
        });
        if (pinned.ok && pinned.data?.notes[0]) {
          return { discussionId: pinned.data.id, noteId: pinned.data.notes[0].id, positioned: true };
        }
        // GitLab's idea of the diff moved (a push since the read), or it refused the
        // line for a reason of its own. The finding matters more than where it sits.
        log.warn(`review: !${mrIid} would not take a thread at ${at.file}:${at.line} — posting it on the MR instead`, {
          status: pinned.status, error: pinned.error?.slice(0, 160),
        });
      }
      const plain = await createMrDiscussion(mrIid, body(false));
      if (!plain.ok || !plain.data?.notes[0]) return null;
      return { discussionId: plain.data.id, noteId: plain.data.notes[0].id, positioned: false };
    },

    async reply(discussionId, body) {
      const res = await replyToMrDiscussion(mrIid, discussionId, body);
      if (res.ok && res.data) return { noteId: res.data.id };
      return gone(res) ? 'gone' : null;
    },

    async setResolved(discussionId, resolved) {
      const res = await setMrDiscussionResolved(mrIid, discussionId, resolved);
      if (res.ok) return 'ok';
      return gone(res) ? 'gone' : 'failed';
    },
  };
}

export type LiveReview =
  | { kind: 'clear' }
  | { kind: 'open'; threads: ReturnType<typeof liveOpenThreads> }
  | { kind: 'unreadable'; why: string };

/**
 * What the merge decides from: the reviewer threads still open on the merge
 * request, read now. Not the ledger and not findings.json — both describe the
 * review as it stood when they were written, and a verdict that outlived the
 * fix it asked for has refused a merge here before.
 */
export async function liveReview(mrIid: number): Promise<LiveReview> {
  const res = await allMrDiscussions(mrIid);
  if (!res.ok || !res.data) return { kind: 'unreadable', why: res.error ?? res.kind };
  const threads = liveOpenThreads(res.data);
  return threads.length ? { kind: 'open', threads } : { kind: 'clear' };
}
