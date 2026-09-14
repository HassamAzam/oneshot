/**
 * The only file in src/mrfeedback that touches src/lib. Everything else here
 * is pure and unit-tested; this builds the real dependencies around it.
 */
import { DRY_RUN, mrFeedbackConfig } from '../lib/config.js';
import { readJournal, updateJournal } from '../lib/artifacts.js';
import {
  getMergeRequest, mrDiscussions, replyToMrDiscussion, resolveMrDiscussion, type GitlabResult,
} from '../lib/gitlab.js';
import { createMergeHooks, type MergeHooks } from './mergehooks.js';
import type { ThreadWriteResult } from './respond.js';

/** Off under DRY_RUN: a dry run posts nothing, so a round could never be answered. */
export function mrFeedbackActive(): boolean {
  return mrFeedbackConfig().enabled && !DRY_RUN;
}

/** A deleted discussion is 'gone' — answered for good — rather than a failure to retry. */
function writeResult(res: GitlabResult<unknown>): ThreadWriteResult {
  if (res.ok) return 'ok';
  return res.kind === 'notfound' ? 'gone' : 'failed';
}

export function mergeHooksFor(iid: number): MergeHooks {
  return createMergeHooks({
    config: mrFeedbackConfig(),
    readLedger: () => readJournal(iid)?.mrFeedback,
    writeLedger: (l) => { updateJournal(iid, { mrFeedback: l }); },
    discussions: async (mrIid) => {
      const res = await mrDiscussions(mrIid);
      return res.ok && res.data ? res.data : null;
    },
    headSha: async (mrIid) => {
      const res = await getMergeRequest(mrIid);
      return res.ok ? res.data?.sha ?? null : null;
    },
    reply: async (mrIid, id, body) => writeResult(await replyToMrDiscussion(mrIid, id, body)),
    resolve: async (mrIid, id) => writeResult(await resolveMrDiscussion(mrIid, id)),
  });
}
