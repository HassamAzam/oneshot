/**
 * Say on GitLab what the ledger has decided, one write at a time.
 *
 * Every write is queued in the ledger BEFORE it is attempted and removed only
 * once it has landed, with the ledger saved after each. So a crash, a dropped
 * VPN or a refused request leaves a queue to replay rather than a decision that
 * was made and never posted — and replaying is safe, because each write is
 * first looked for on the merge request by its marker: a thread that already
 * exists is adopted, a reply that is already there is not posted again.
 */
import type { MrDiscussion } from '../mrfeedback/types.js';
import { parseMarker, type ReviewMarker } from './markers.js';
import { threadBody } from './notes.js';
import type { ReviewApi, ReviewLedger } from './types.js';

const sameMarker = (a: ReviewMarker | null, b: ReviewMarker): boolean =>
  a !== null && a.role === b.role && a.finding === b.finding && a.action === b.action
  && a.run === b.run && a.lap === b.lap;

/**
 * Attempt every pending write in order, stopping at the first that fails.
 * `live` is the merge request's discussions as just read; `save` is called
 * after each write that lands. Returns the ledger as it now stands and, when a
 * write did not land, what stopped it.
 */
export async function flush(
  ledger: ReviewLedger, api: ReviewApi, o: { live: MrDiscussion[]; save(l: ReviewLedger): void },
): Promise<{ ledger: ReviewLedger; failed: string | null }> {
  const l = JSON.parse(JSON.stringify(ledger)) as ReviewLedger;
  const done = (): void => { l.pending.shift(); o.save(l); };

  while (l.pending.length) {
    const w = l.pending[0]!;
    const t = l.threads.find((x) => x.id === w.finding);
    if (!t) { done(); continue; }

    if (w.op === 'create') {
      if (t.discussionId) { done(); continue; }
      const existing = o.live.find((d) => {
        const m = parseMarker(d.notes[0]?.body);
        return m?.role === 'reviewer' && m.action === 'raised' && m.finding === t.id && m.run === l.runId;
      });
      if (existing) {
        t.discussionId = existing.id;
        t.noteId = existing.notes[0]?.id ?? null;
        t.positioned = Boolean(existing.notes[0]?.position);
        t.lastNoteId = t.noteId ?? undefined;
        done();
        continue;
      }
      const made = await api.createThread(
        { file: t.file, line: t.line },
        (positioned) => threadBody(t, { runId: l.runId, positioned }),
      );
      if (!made) return { ledger: l, failed: `could not open the thread for ${t.id} on !${l.mrIid}` };
      t.discussionId = made.discussionId;
      t.noteId = made.noteId;
      t.positioned = made.positioned;
      t.lastNoteId = made.noteId;
      done();
      continue;
    }

    if (!t.discussionId) {
      return { ledger: l, failed: `${t.id} has an answer to post but no thread on !${l.mrIid} yet` };
    }
    // `lastNoteId` is NOT moved to a note this loop posts. It marks how far a
    // PERSON's replies have been put in front of the fixer (applyFix moves it),
    // and the loop's own notes are told apart by their marker. Moving it here
    // skipped any comment a person wrote while a session was still running: it
    // has a lower id than the reply posted when the session ends.
    const discussion = o.live.find((d) => d.id === t.discussionId);
    const already = discussion?.notes.find((n) => sameMarker(parseMarker(n.body), w.marker));
    if (!already) {
      const posted = await api.reply(t.discussionId, w.body);
      if (posted === null) return { ledger: l, failed: `could not reply on the thread for ${t.id} on !${l.mrIid}` };
      if (posted === 'gone') {
        // Deleted on GitLab while this was queued: there is nothing left to answer.
        t.status = 'closed'; t.resolved = true; delete t.human;
        done();
        continue;
      }
    }
    if (w.then !== 'none') {
      const r = await api.setResolved(t.discussionId, w.then === 'resolve');
      if (r === 'failed') {
        // The reply is up; only the state change is owed. Saved now, so the next
        // attempt finds the reply by its marker and does not post it twice.
        o.save(l);
        return {
          ledger: l,
          failed: `could not ${w.then === 'resolve' ? 'resolve' : 'reopen'} the thread for ${t.id} on !${l.mrIid}`,
        };
      }
      if (r === 'gone') { t.status = 'closed'; t.resolved = true; delete t.human; }
    }
    done();
  }
  return { ledger: l, failed: null };
}
