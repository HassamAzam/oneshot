/**
 * The text of every note the review loop posts. Pure.
 *
 * Everything a model wrote goes through inertNoteText first, for the reason
 * src/mrfeedback/respond.ts gives: GitLab runs quick actions found at the start
 * of a line in any API-created note, under the conductor's token, and `@name`
 * pings a person. A finding or a fixer's reply must not be able to do either.
 *
 * Each body ends with its marker (markers.ts) — the one thing that tells these
 * notes apart from one another and from a person's.
 */
import { inertNoteText } from '../mrfeedback/respond.js';
import { isBlocking, renderMarker, type ReviewMarker, type ReviewSeverity } from './markers.js';
import type { ReviewThread } from './types.js';

const clean = (text: string): string => inertNoteText(String(text ?? '').trim());
const short = (sha: string): string => String(sha ?? '').slice(0, 8);

/** The note that opens a thread: the finding, written to be read on the MR by a person. */
export function threadBody(t: ReviewThread, o: { runId: string; positioned: boolean }): string {
  const marker: ReviewMarker = {
    role: 'reviewer', finding: t.id, action: 'raised', severity: t.severity, run: o.runId, lap: t.raisedLap,
  };
  // On a diff line GitLab shows the code; on the MR as a whole the location is all there is.
  const where = o.positioned ? '' : `\n\n\`${t.file}:${t.line}\``;
  return [
    `**${t.id} · ${t.severity}** — ${clean(t.what)}${where}`,
    t.why ? `**Why it matters:** ${clean(t.why)}` : '',
    t.fix ? `**Suggested fix:** ${clean(t.fix)}` : '',
    `<sub>Oneshot code review · ${isBlocking(t.severity) ? 'must be resolved before merge' : 'non-blocking'}</sub>`,
    renderMarker(marker),
  ].filter(Boolean).join('\n\n');
}

/** The fixer's answer on a thread. */
export function fixerReplyBody(o: {
  thread: ReviewThread; action: 'fixed' | 'declined'; reply: string; commit: string; runId: string; lap: number;
}): string {
  const marker: ReviewMarker = { role: 'fixer', finding: o.thread.id, action: o.action, run: o.runId, lap: o.lap };
  const said = clean(o.reply) || (o.action === 'fixed' ? 'Fixed.' : 'No change made.');
  if (o.action === 'fixed') {
    const at = o.commit ? ` in \`${short(o.commit)}\`` : '';
    return `**Fixed**${at} — ${said}\n\n<sub>Oneshot fixer · the reviewer re-checks this fix</sub>\n${renderMarker(marker)}`;
  }
  const tail = isBlocking(o.thread.severity)
    ? 'Left open: the reviewer rules on this next, and a person after that if they still disagree.'
    : `Non-blocking (${o.thread.severity}), so this thread is closed with the note above.`;
  return `**Not changed** — ${said}\n\n<sub>Oneshot fixer · ${tail}</sub>\n${renderMarker(marker)}`;
}

/** The reviewer's ruling on a thread it re-checked. */
export function rulingBody(o: {
  thread: ReviewThread; action: 'reopened' | 'withdrawn' | 'accepted' | 'stands';
  note: string; headSha: string; runId: string; lap: number;
}): string {
  const marker: ReviewMarker = { role: 'reviewer', finding: o.thread.id, action: o.action, run: o.runId, lap: o.lap };
  const note = clean(o.note);
  const head = {
    reopened: `**Reopened** — the fix does not close this.${note ? ` ${note}` : ''}`,
    withdrawn: `**Withdrawn** — ${note || 'the reason given above holds.'}`,
    accepted: `**Verified** at \`${short(o.headSha)}\`${note ? ` — ${note}` : '.'}`,
    stands: `**Still stands** — ${note || 'the reason given for leaving it does not hold.'}`
      + '\n\nThe fixer and the reviewer disagree here, so this one needs a person: resolve the thread '
      + 'once it is decided, or reply with what to do.',
  }[o.action];
  return `${head}\n\n<sub>Oneshot code review · re-check</sub>\n${renderMarker(marker)}`;
}

/** Closing a non-blocking thread nobody took up, so it does not hold a merge that needs every thread resolved. */
export function closedBody(o: { thread: ReviewThread; runId: string; lap: number }): string {
  const marker: ReviewMarker = { role: 'reviewer', finding: o.thread.id, action: 'closed', run: o.runId, lap: o.lap };
  return `Closed without a change: a non-blocking ${o.thread.severity} that was not taken up in this merge request.`
    + ` It stays here for whoever picks it up later.\n\n<sub>Oneshot code review</sub>\n${renderMarker(marker)}`;
}

/** How one open thread is described to a person: in the park note, the merge refusal and the logs. */
export function threadLine(t: ReviewThread, mrUrl?: string): string {
  const why: Record<string, string> = {
    open: 'not answered yet',
    reopened: 'the fix was re-checked and does not close it',
    declined: 'the fixer declined it; the reviewer has not ruled yet',
    disputed: 'the fixer declined it and the reviewer stands by it',
  };
  const link = mrUrl && t.noteId ? ` — ${mrUrl}#note_${t.noteId}` : '';
  return `**${t.id}** [${t.severity}] \`${t.file}:${t.line}\` — ${clean(t.what)} _(${why[t.status] ?? t.status})_${link}`;
}

/** The ticket note that says a person is needed, and exactly on what. */
export function parkNoteBody(o: {
  threads: ReviewThread[]; mrIid: number; mrUrl: string; runId: string; fixLaps: number; maxFixLaps: number;
}): string {
  const n = o.threads.length;
  return [
    `## Code review needs a person — ${n} thread${n === 1 ? '' : 's'} open on !${o.mrIid}`,
    `Oneshot's reviewer and fixer could not close ${n === 1 ? 'this' : 'these'} between them `
      + `(${o.fixLaps} of ${o.maxFixLaps} fix lap${o.maxFixLaps === 1 ? '' : 's'} used). `
      + 'The run is parked here and has not gone on to verify:',
    o.threads.map((t) => `- ${threadLine(t, o.mrUrl)}`).join('\n'),
    'To continue, on the merge request: **resolve** a thread once you have decided it — the run picks up on its '
      + 'next check — or **reply** on the thread with what to do, and the fixer acts on a reply from a configured '
      + 'reviewer.',
    `<sub>Run \`${o.runId}\`</sub>`,
    `<!-- oneshot:review-park run=${o.runId} -->`,
  ].join('\n\n');
}

/** One line for a reason string or a log, never the whole list. */
export function openSummary(threads: ReviewThread[]): string {
  return threads.map((t) => `${t.id} [${t.severity as ReviewSeverity}]`).join(', ');
}
