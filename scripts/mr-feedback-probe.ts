/**
 * `npm run mr-feedback:probe -- <mrIid> [ticketIid]` — read-only.
 *
 * Prints the threads on an MR that the review-feedback loop would act on right
 * now, under the live config and (given a ticket) that run's watermarks. The
 * first thing to run when a comment was, or was not, picked up.
 */
import { mrFeedbackConfig } from '../src/lib/config.js';
import { readJournal } from '../src/lib/artifacts.js';
import { mrDiscussions } from '../src/lib/gitlab.js';
import { actionableThreads } from '../src/mrfeedback/threads.js';

const mrIid = Number(process.argv[2]);
const ticketIid = Number(process.argv[3] ?? 0);
if (!Number.isInteger(mrIid) || mrIid <= 0) {
  console.error('usage: npm run mr-feedback:probe -- <mrIid> [ticketIid]');
  process.exit(2);
}

const cfg = mrFeedbackConfig();
const res = await mrDiscussions(mrIid);
if (!res.ok || !res.data) {
  console.error(`cannot read !${mrIid}: ${res.error ?? res.kind}`);
  process.exit(1);
}
const handled = ticketIid ? readJournal(ticketIid)?.mrFeedback?.handled ?? {} : {};
const actionable = actionableThreads(res.data, { authors: cfg.authors, handled });
console.log(JSON.stringify({ config: cfg, discussions: res.data.length, handled, actionable }, null, 2));
