/**
 * The review loop's state transitions. Pure: every function takes a ledger and
 * returns a new one, and nothing here talks to GitLab, git or a session.
 *
 * WHAT THE LOOP IS. A reviewer session reads the change and returns findings;
 * the conductor posts each as its own thread on the merge request. A separate
 * fixer session answers the open threads — a commit and a reply, or a reason
 * for leaving it — and the conductor pushes, replies and resolves. The reviewer
 * then re-checks: it rules on each answer and may reopen a thread whose fix is
 * wrong. `nextStep` says which of those is owed.
 *
 * WHY IT IS BUILT THIS WAY. The loop it replaces handed every finding back to
 * `implement`, re-ran the whole review on the result, and let that review grade
 * the change from scratch each time. On #9174 it never converged: lap 2 raised
 * a lap-0 suggestion to a blocker; lap 4 raised two new majors against a test
 * the previous lap had added at the reviewer's own suggestion; and with the lap
 * budget spent, the run carried a verdict it could not act on through verify,
 * evidence and the MR, to a merge that was always going to refuse. Three rules
 * here are what make this one converge:
 *
 *   - a thread's severity is fixed when it is raised (a re-check may reopen a
 *     thread, never re-grade or re-number it);
 *   - a re-check may raise a NEW thread only for a blocker, or for a defect in
 *     a file the commits since the last review touched (`applyReview`);
 *   - a thread the fixer declined and the reviewer upheld is `disputed`, and is
 *     not handed to the fixer again — it goes to a person at once, instead of
 *     the two sessions spending the remaining laps disagreeing.
 */
import type { MrDiscussion } from '../mrfeedback/types.js';
import {
  findingNumber, isBlocking, isReviewNote, normaliseFindingId, parseMarker, type ReviewMarker,
  type ReviewSeverity,
} from './markers.js';
import { closedBody, fixerReplyBody, openSummary, rulingBody } from './notes.js';
import { repoPath } from './position.js';
import type {
  DroppedFinding, FixPromptInput, FixerOutput, RawFinding, ReviewLedger, ReviewPromptInput, ReviewThread,
  ReviewerOutput, Ruling, ThreadWrite,
} from './types.js';

const SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'major', 'minor', 'suggestion'];
const RULINGS: readonly Ruling[] = ['accepted', 'reopen', 'withdrawn', 'stands'];

export function emptyLedger(runId: string, mrIid: number): ReviewLedger {
  return { version: 1, runId, mrIid, reviewedSha: null, recheckOwed: false, threads: [], pending: [], dropped: [] };
}

const clone = (l: ReviewLedger): ReviewLedger => JSON.parse(JSON.stringify(l)) as ReviewLedger;

// ------------------------------------------------------------------ selectors

/** Threads still open on GitLab, as far as this run knows. */
export function openThreads(l: ReviewLedger): ReviewThread[] {
  return l.threads.filter((t) => !t.resolved);
}

/** The open threads a merge must not ride over. */
export function openBlocking(l: ReviewLedger): ReviewThread[] {
  return openThreads(l).filter((t) => isBlocking(t.severity));
}

/**
 * The open threads the fixer can usefully be handed: never answered, reopened
 * by the reviewer — or any open thread a trusted person has replied on, since
 * that reply is new information whatever the two sessions concluded before it.
 */
export function fixableThreads(l: ReviewLedger): ReviewThread[] {
  return openThreads(l).filter((t) => t.status === 'open' || t.status === 'reopened' || Boolean(t.human?.length));
}

function nextNumber(l: ReviewLedger): number {
  return l.threads.reduce((m, t) => Math.max(m, findingNumber(t.id)), 0) + 1;
}

const fid = (n: number): string => `F-${String(n).padStart(2, '0')}`;

// ----------------------------------------------------------------- what is owed

/** Fixer laps a person's reply may start past the lap cap before it is left for the person. */
export const MAX_HUMAN_TRIES = 2;

export type Step =
  /** Writes are waiting to land on GitLab. Nothing else happens until they do. */
  | { kind: 'flush' }
  | { kind: 'review'; recheck: boolean }
  | { kind: 'fix'; threads: ReviewThread[] }
  /** Only non-blocking threads are left and no lap remains for them: the run closes them. */
  | { kind: 'close'; threads: ReviewThread[] }
  | { kind: 'park'; threads: ReviewThread[]; why: string }
  | { kind: 'done' };

/**
 * What the loop does next.
 *
 * `fixLapsUsed` is counted by the caller from the journal, since the code last
 * changed outside the loop. A person's reply on a thread is honoured past the
 * cap: the cap bounds the two sessions arguing with each other, not a person
 * asking for one more change.
 */
export function nextStep(
  l: ReviewLedger, o: { head: string; fixLapsUsed: number; maxFixLaps: number },
): Step {
  if (l.pending.length) return { kind: 'flush' };
  if (l.reviewedSha === null) return { kind: 'review', recheck: false };
  if (l.recheckOwed || l.reviewedSha !== o.head) return { kind: 'review', recheck: true };

  const fixable = fixableThreads(l);
  if (fixable.length) {
    // Past the cap only for a person's reply, and only so many times: a fixer
    // that keeps dying on the same reply is not a reason to keep starting one.
    const asked = fixable.some((t) => t.human?.length && (t.humanTries ?? 0) < MAX_HUMAN_TRIES);
    if (o.fixLapsUsed < o.maxFixLaps || asked) return { kind: 'fix', threads: fixable };
  }

  // What waits on a person: every open blocker or major, and any open thread a
  // person replied on that no fixer lap answered — whatever its severity, since
  // closing it "not taken up" under their comment would be untrue.
  const blocking = openThreads(l).filter((t) => isBlocking(t.severity) || Boolean(t.human?.length));
  if (blocking.length) {
    const disputed = blocking.filter((t) => t.status === 'disputed').length;
    const why = `${blocking.length} review thread(s) on !${l.mrIid} need a person: ${openSummary(blocking)} — `
      + (disputed === blocking.length
        ? 'the fixer declined each and the reviewer stands by it'
        : `still open after ${o.fixLapsUsed} of ${o.maxFixLaps} fix lap(s)`);
    return { kind: 'park', threads: blocking, why };
  }

  const leftover = openThreads(l);
  if (leftover.length) return { kind: 'close', threads: leftover };
  return { kind: 'done' };
}

/** True when nothing is owed for `head`: the cheap "is review settled" the run loop asks every pass. */
export function reviewSettled(l: ReviewLedger | null, head: string | null): boolean {
  if (!l || !head) return false;
  return nextStep(l, { head, fixLapsUsed: 0, maxFixLaps: 0 }).kind === 'done';
}

// ------------------------------------------------------- what each session is shown

export function reviewInput(
  l: ReviewLedger, o: { recheck: boolean; headSha: string; changedFiles: string[] | null },
): ReviewPromptInput {
  return {
    recheck: o.recheck, mrIid: l.mrIid, sinceSha: l.reviewedSha, headSha: o.headSha,
    changedFiles: o.changedFiles, threads: l.threads,
  };
}

export function fixInput(
  l: ReviewLedger, o: { threads: ReviewThread[]; headSha: string; lap: number; maxLaps: number },
): FixPromptInput {
  return { mrIid: l.mrIid, headSha: o.headSha, threads: o.threads, lap: o.lap, maxLaps: o.maxLaps };
}

// ------------------------------------------------------------ the reviewer's lap

interface Finding {
  id: string | null; severity: ReviewSeverity; file: string; line: number; what: string; why: string; fix: string;
}

/** The findings of one reviewer answer that are well-formed enough to post. */
function readFindings(raw: unknown, root?: string | null): Finding[] {
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  for (const f of raw as RawFinding[]) {
    if (!f || typeof f !== 'object') continue;
    const severity = String(f.severity ?? '') as ReviewSeverity;
    const what = String(f.what ?? '').trim();
    if (!SEVERITIES.includes(severity) || !what) continue;
    const line = Number(f.line);
    out.push({
      id: normaliseFindingId(f.id),
      severity,
      file: repoPath(f.file, root),
      line: Number.isFinite(line) && line > 0 ? Math.floor(line) : 1,
      what,
      why: String(f.why ?? '').trim(),
      fix: String(f.fix ?? '').trim(),
    });
  }
  return out;
}

function readRulings(raw: unknown): Map<string, { ruling: Ruling; note: string }> {
  const out = new Map<string, { ruling: Ruling; note: string }>();
  if (!Array.isArray(raw)) return out;
  for (const r of raw as Array<{ id?: unknown; ruling?: unknown; note?: unknown }>) {
    const id = normaliseFindingId(r?.id);
    const ruling = String(r?.ruling ?? '') as Ruling;
    if (!id || !RULINGS.includes(ruling)) continue;
    out.set(id, { ruling, note: String(r?.note ?? '').trim() });
  }
  return out;
}

function reply(
  l: ReviewLedger, t: ReviewThread, action: 'reopened' | 'withdrawn' | 'accepted' | 'stands',
  note: string, o: { lap: number; headSha: string }, then: 'resolve' | 'unresolve' | 'none',
): ThreadWrite {
  return {
    op: 'reply', finding: t.id, then,
    marker: { role: 'reviewer', finding: t.id, action, run: l.runId, lap: o.lap },
    body: rulingBody({ thread: t, action, note, headSha: o.headSha, runId: l.runId, lap: o.lap }),
  };
}

/** Apply one ruling to one thread. Returns the write it calls for, if any. */
function rule(
  l: ReviewLedger, t: ReviewThread, r: { ruling: Ruling; note: string } | undefined,
  o: { lap: number; headSha: string },
): ThreadWrite | null {
  const ruling = r?.ruling;
  const note = r?.note ?? '';
  // A person's reply that no fixer lap has been handed keeps the thread open,
  // whatever the two sessions conclude between themselves: the reviewer can say
  // the fix failed, but neither of them can close it over that reply.
  if ((ruling === 'accepted' || ruling === 'withdrawn') && t.human?.length) return null;
  switch (t.status) {
    case 'fixed':
      // `stands` is the word for a declined thread, but on a fixed one it can
      // only mean "the finding still stands": the fix did not close it.
      if (ruling === 'reopen' || ruling === 'stands') {
        t.status = 'reopened'; t.resolved = false; t.reviewerNote = note;
        return reply(l, t, 'reopened', note, o, 'unresolve');
      }
      // Silence is no objection: the reviewer was shown the fix and asked.
      t.status = 'accepted';
      return null;
    case 'declined':
      if (ruling === 'withdrawn' || ruling === 'accepted') {
        t.status = 'withdrawn'; t.resolved = true;
        return reply(l, t, 'withdrawn', note, o, 'resolve');
      }
      // No ruling is not a ruling. The thread stays declined and still holds the
      // run for a person, described as what it is — "the reviewer has not ruled" —
      // rather than with a "Still stands" the reviewer never wrote.
      if (ruling === undefined) return null;
      // Declined and upheld: no further lap changes either session's mind.
      t.status = 'disputed'; t.reviewerNote = note;
      return reply(l, t, 'stands', note, o, 'none');
    case 'open':
    case 'reopened':
    case 'disputed':
      // The fixer never answered (its session died), or a later commit closed it anyway.
      if (ruling === 'accepted') {
        t.status = 'accepted'; t.resolved = true;
        return reply(l, t, 'accepted', note, o, 'resolve');
      }
      if (ruling === 'withdrawn') {
        t.status = 'withdrawn'; t.resolved = true;
        return reply(l, t, 'withdrawn', note, o, 'resolve');
      }
      return null;
    case 'accepted':
      // A later commit can break an earlier fix. A thread a person closed, or the
      // reviewer itself withdrew, is not the reviewer's to open again.
      if (ruling === 'reopen') {
        t.status = 'reopened'; t.resolved = false; t.reviewerNote = note;
        return reply(l, t, 'reopened', note, o, 'unresolve');
      }
      return null;
    default:
      return null;
  }
}

/**
 * Fold one reviewer answer into the ledger.
 *
 * A first review turns every finding into a thread. A re-check rules on the
 * threads it was shown, and its NEW findings are held to the rule in this
 * file's header: a blocker, or a defect in a file the commits since the last
 * review touched. Anything else is recorded in `dropped` and not posted —
 * enforced here, in code, because the prompt asking for it is the same kind of
 * instruction the old loop's reviewer talked itself past.
 *
 * `changedFiles` null means git could not say what changed; a re-check is then
 * held to blockers only, since nothing can be shown to be new.
 */
export function applyReview(
  ledger: ReviewLedger, out: ReviewerOutput,
  o: {
    lap: number; headSha: string; recheck: boolean; changedFiles: string[] | null; root?: string | null;
    /** The answer is not a whole review (it died, or says it did not cover the change): keep its findings, still owe the review. */
    partial?: boolean;
  },
): { ledger: ReviewLedger; raised: string[]; dropped: DroppedFinding[] } {
  const l = clone(ledger);
  const writes: ThreadWrite[] = [];
  const raised: string[] = [];
  const dropped: DroppedFinding[] = [];
  const findings = readFindings(out.findings, o.root);
  /** Findings that were a ruling on an existing thread, not something new to post. */
  const wasRuling = new Set<Finding>();

  if (o.recheck) {
    const rulings = readRulings(out.threads);
    // A finding returned under an existing thread's id, about that thread's own
    // file, is the old way of saying "this fix did not work": it is read as a
    // reopen, never as a second thread. The same id on a DIFFERENT file, or
    // beside a ruling that closes the thread, is a new finding the reviewer
    // numbered from F-01 again — and that one must not vanish into the old
    // thread: it falls through and takes a fresh id below.
    for (const f of findings) {
      const t = f.id ? l.threads.find((x) => x.id === f.id) : undefined;
      if (!t || t.file !== f.file) continue;
      // The same id on the same file as a FINISHED thread is that thread raised
      // again. A thread a person closed, the run closed as declined, or the
      // reviewer itself withdrew is not the reviewer's to reopen or re-grade —
      // on #9174 that is how a declined suggestion came back as a blocker. It is
      // not posted, and it is not lost without a trace either.
      if (t.status === 'closed' || t.status === 'withdrawn') {
        dropped.push({
          lap: o.lap, severity: f.severity, file: f.file, line: f.line, what: f.what,
          reason: `${t.id} is finished (${t.status}) and a re-check cannot reopen or re-grade it — `
            + 'a different defect needs an id of its own',
        });
        wasRuling.add(f);
        continue;
      }
      const said = rulings.get(t.id);
      // Beside a ruling that CLOSES the thread the finding is something else.
      if (said && (said.ruling === 'accepted' || said.ruling === 'withdrawn')) continue;
      // Otherwise it is the thread's own finding said again — with no ruling
      // (read as reopen), or beside `reopen` or `stands`, which already say it.
      const words = [f.what, f.why].filter(Boolean).join(' ');
      if (!said) rulings.set(t.id, { ruling: 'reopen', note: words });
      else if (!said.note) said.note = words;
      wasRuling.add(f);
    }
    for (const t of l.threads) {
      const w = rule(l, t, rulings.get(t.id), o);
      if (w) writes.push(w);
    }
  }

  const changed = o.changedFiles ? new Set(o.changedFiles.map((f) => repoPath(f, o.root))) : null;
  const taken = new Set(l.threads.map((t) => t.id));
  let n = nextNumber(l);
  for (const f of findings) {
    if (wasRuling.has(f)) continue;
    if (o.recheck && f.severity !== 'blocker' && !(changed && changed.has(f.file))) {
      dropped.push({
        lap: o.lap, severity: f.severity, file: f.file, line: f.line, what: f.what,
        reason: changed
          ? 'a re-check may raise a new thread only for a blocker or in a file changed since the last review'
          : 'git could not say what changed since the last review, so only a blocker may be raised',
      });
      continue;
    }
    // The reviewer's own ids are kept where they are usable, because its summary
    // refers to them; a clash or a malformed one is renumbered rather than trusted.
    let id = f.id && !taken.has(f.id) && !o.recheck ? f.id : null;
    if (!id) {
      while (taken.has(fid(n))) n += 1;
      id = fid(n);
    }
    taken.add(id);
    l.threads.push({
      id, severity: f.severity, file: f.file, line: f.line, what: f.what, why: f.why, fix: f.fix,
      raisedLap: o.lap, discussionId: null, noteId: null, positioned: false, status: 'open', resolved: false,
    });
    writes.push({ op: 'create', finding: id });
    raised.push(id);
  }

  l.pending.push(...writes);
  l.dropped.push(...dropped);
  l.reviewLap = o.lap;
  if (o.partial) return { ledger: l, raised, dropped };
  l.reviewedSha = o.headSha;
  l.recheckOwed = false;
  const summary = String(out.summary ?? '').replace(/\s+/g, ' ').trim();
  if (summary) l.reviewSummary = summary.slice(0, 1200);
  return { ledger: l, raised, dropped };
}

/**
 * Whether a FIRST review says of itself that it did not cover the change.
 *
 * The reviewer is told to return 'changes-requested' in two cases: it found a
 * blocker or a major, or a dimension it dispatched neither landed nor was
 * covered. The loop is built from findings and never needed the verdict for the
 * first case — which left the second with nothing reading it: a review that
 * said "backend NOT REVIEWED" and listed two minors was posted, answered and
 * counted as the whole review. 'changes-requested' with nothing blocking behind
 * it is that case, and the caller re-attempts the review instead of accepting it.
 */
export function reviewIsIncomplete(out: ReviewerOutput, o: { openBlocking?: boolean } = {}): boolean {
  // The reviewer's own words for it (src/phases/prompts.ts tells it to write
  // exactly this): said beside a blocker it is still half a review.
  if (/\bNOT REVIEWED\b/.test(String(out.summary ?? ''))) return true;
  if (String(out.verdict ?? '') !== 'changes-requested') return false;
  // Something blocking explains the verdict: a finding in this answer, or a
  // thread already open that the reviewer was told not to raise again.
  if (o.openBlocking) return false;
  return !readFindings(out.findings).some((f) => isBlocking(f.severity));
}

// --------------------------------------------------------------- the fixer's lap

interface Answer { action: 'fixed' | 'declined'; reply: string; commit: string }

function readAnswers(raw: unknown): Map<string, Answer> {
  const out = new Map<string, Answer>();
  if (!Array.isArray(raw)) return out;
  for (const a of raw as Array<{ id?: unknown; action?: unknown; reply?: unknown; commit?: unknown }>) {
    const id = normaliseFindingId(a?.id);
    const action = String(a?.action ?? '');
    if (!id || (action !== 'fixed' && action !== 'declined')) continue;
    out.set(id, { action, reply: String(a?.reply ?? '').trim(), commit: String(a?.commit ?? '').trim() });
  }
  return out;
}

/**
 * Fold one fixer answer into the ledger.
 *
 * Only the threads the fixer was HANDED are touched: an id it was not given is
 * ignored, which is what "the fixer never raises findings" means in code. A
 * 'fixed' with no commit on the branch is not a fix, whatever the session says,
 * so it is recorded as declined and the thread stays where it was.
 *
 * A declined blocker or major stays open for the reviewer to rule on. A
 * declined minor or suggestion is answered and closed: the project requires
 * every thread resolved before a merge, and a non-blocking note that will not
 * be taken up should not need a person to click it away.
 */
export function applyFix(
  ledger: ReviewLedger, out: FixerOutput,
  o: { lap: number; headBefore: string; headAfter: string; handed: string[] },
): { ledger: ReviewLedger; fixed: string[]; declined: string[]; unanswered: string[] } {
  const l = clone(ledger);
  const answers = readAnswers(out.threads);
  const committed = o.headBefore !== o.headAfter;
  const fixed: string[] = [];
  const declined: string[] = [];
  const unanswered: string[] = [];
  let blockingDeclined = false;

  for (const id of o.handed) {
    const t = l.threads.find((x) => x.id === id);
    if (!t || t.resolved) continue;
    const a = answers.get(id);
    if (!a) {
      // Left out of the answer. A person's reply on it has NOT been dealt with,
      // so it is not marked seen: the thread comes back with the reply still on
      // it, and the lap counts as one of that reply's tries.
      if (t.human?.length) t.humanTries = (t.humanTries ?? 0) + 1;
      unanswered.push(id);
      continue;
    }
    // Answered: whatever a person said on the thread was in front of the fixer when it did.
    if (t.human?.length) {
      t.lastNoteId = Math.max(t.lastNoteId ?? 0, ...t.human.map((h) => h.noteId));
      delete t.human;
      delete t.humanTries;
    }

    const reallyFixed = a.action === 'fixed' && committed;
    const text = a.action === 'fixed' && !committed
      ? `${a.reply}\n\n(Reported as fixed, but this lap made no commit, so nothing changed on the branch.)`.trim()
      : a.reply;
    const action: 'fixed' | 'declined' = reallyFixed ? 'fixed' : 'declined';
    const commit = reallyFixed ? (a.commit || o.headAfter) : '';
    t.fixer = { lap: o.lap, action, reply: text, commit };
    const body = fixerReplyBody({ thread: t, action, reply: text, commit, runId: l.runId, lap: o.lap });
    const marker: ReviewMarker = { role: 'fixer', finding: id, action, run: l.runId, lap: o.lap };

    if (reallyFixed) {
      t.status = 'fixed'; t.resolved = true;
      l.pending.push({ op: 'reply', finding: id, marker, body, then: 'resolve' });
      fixed.push(id);
    } else if (isBlocking(t.severity)) {
      t.status = 'declined';
      blockingDeclined = true;
      l.pending.push({ op: 'reply', finding: id, marker, body, then: 'none' });
      declined.push(id);
    } else {
      t.status = 'closed'; t.resolved = true;
      l.pending.push({ op: 'reply', finding: id, marker, body, then: 'resolve' });
      declined.push(id);
    }
  }

  // The reviewer looks again when there is something for it to look at: new
  // commits, or a blocker the fixer would rather not fix.
  l.recheckOwed = l.recheckOwed || committed || blockingDeclined;
  if (committed) l.pushOwed = true;
  return { ledger: l, fixed, declined, unanswered };
}

/** Close the non-blocking threads nobody took up (nextStep's `close`). */
export function closeLeftover(ledger: ReviewLedger, ids: string[], lap: number): ReviewLedger {
  const l = clone(ledger);
  for (const id of ids) {
    const t = l.threads.find((x) => x.id === id);
    if (!t || t.resolved || isBlocking(t.severity)) continue;
    t.status = 'closed'; t.resolved = true;
    l.pending.push({
      op: 'reply', finding: id, then: 'resolve',
      marker: { role: 'reviewer', finding: id, action: 'closed', run: l.runId, lap },
      body: closedBody({ thread: t, runId: l.runId, lap }),
    });
  }
  return l;
}

// ------------------------------------------------------------- what GitLab says

/** Whether a discussion still has an unresolved resolvable note. */
export function discussionOpen(d: MrDiscussion): boolean {
  return d.notes.some((n) => n.resolvable && !n.resolved);
}

/**
 * Bring the ledger up to date with the merge request.
 *
 * GitLab is the truth about whether a thread is open, and people act there: a
 * person who resolves a thread has decided it, one who reopens it wants it
 * looked at again, and a reply from a trusted reviewer is an instruction for the
 * fixer. `trusted` is the same allow-list src/mrfeedback acts on — an MR comment
 * is input to a session that can commit to the branch, so anyone else's notes
 * are dropped here, in code, rather than labelled for a model.
 *
 * A fresh ledger also ADOPTS the open reviewer threads already on the MR (a
 * re-run against the same merge request), so the fixer answers them instead of
 * the reviewer raising each a second time. Only threads this run's own account
 * opened (`self`): the marker is text anyone who can comment could type, and an
 * adopted thread's body is handed to a session that commits to the branch. With
 * `self` unknown nothing is adopted, and the reviewer reads the change afresh.
 */
export function syncLive(
  ledger: ReviewLedger, discussions: MrDiscussion[], o: { trusted: string[]; self?: string | null },
): ReviewLedger {
  const l = clone(ledger);
  const trusted = new Set(o.trusted);
  const byId = new Map(discussions.map((d) => [d.id, d]));
  const pendingFor = new Set(l.pending.map((w) => w.finding));

  // A thread the ledger never got the id of: the create landed and the write-back did not.
  for (const t of l.threads) {
    if (t.discussionId) continue;
    const found = discussions.find((d) => {
      const m = parseMarker(d.notes[0]?.body);
      return m?.role === 'reviewer' && m.action === 'raised' && m.finding === t.id && m.run === l.runId;
    });
    if (found) {
      t.discussionId = found.id;
      t.noteId = found.notes[0]?.id ?? null;
      t.positioned = Boolean(found.notes[0]?.position);
      l.pending = l.pending.filter((w) => !(w.op === 'create' && w.finding === t.id));
    }
  }

  for (const t of l.threads) {
    if (!t.discussionId || pendingFor.has(t.id)) continue; // not yet said what the ledger holds: do not overrule it
    const d = byId.get(t.discussionId);
    if (!d) {
      // Deleted on GitLab. Nothing is left to answer or to hold a merge.
      t.status = 'closed'; t.resolved = true; delete t.human; delete t.humanTries;
      continue;
    }
    const open = discussionOpen(d);
    if (!open && !t.resolved) {
      t.status = 'closed'; t.resolved = true; delete t.human; delete t.humanTries;
      continue;
    }
    if (open && t.resolved) { t.status = 'open'; t.resolved = false; }
    if (!open) continue;
    const fresh = d.notes.filter((n) => !n.system && !isReviewNote(n.body)
      && n.id > (t.lastNoteId ?? 0) && trusted.has(n.author.username));
    if (fresh.length) {
      // A reply the ledger has not held before is a new request, with tries of
      // its own: the count is of laps that died on what was asked, not on the thread.
      const known = new Set((t.human ?? []).map((h) => h.noteId));
      if (fresh.some((n) => !known.has(n.id))) delete t.humanTries;
      t.human = fresh.map((n) => ({ noteId: n.id, author: n.author.username, body: n.body }));
    } else {
      delete t.human;
      delete t.humanTries;
    }
  }

  if (l.reviewedSha === null && l.threads.length === 0 && o.self) {
    let n = 1;
    for (const d of discussions) {
      const first = d.notes[0];
      const m = parseMarker(first?.body);
      if (!first || m?.role !== 'reviewer' || m.action !== 'raised' || !discussionOpen(d)) continue;
      if (first.author.username !== o.self) continue;
      l.threads.push({
        id: fid(n), severity: m.severity ?? 'major',
        file: first.position?.new_path ?? first.position?.old_path ?? '',
        line: first.position?.new_line ?? first.position?.old_line ?? 1,
        // The thread's own text stands in for the finding: it is what the reviewer wrote.
        what: first.body.replace(/<!--[\s\S]*?-->/g, '').replace(/<sub>[\s\S]*?<\/sub>/g, '').trim().slice(0, 1500),
        why: '', fix: '', raisedLap: 0, discussionId: d.id, noteId: first.id,
        positioned: Boolean(first.position), status: 'open', resolved: false,
        lastNoteId: Math.max(...d.notes.filter((x) => isReviewNote(x.body)).map((x) => x.id)),
      });
      n += 1;
    }
  }
  return l;
}

/**
 * The open reviewer threads on a merge request, read from GitLab alone.
 *
 * What the merge decides from: not this run's ledger and not findings.json,
 * both of which describe the review as it was when they were written. A thread
 * counts when its first note carries a reviewer `raised` marker — any run's —
 * and it is still unresolved.
 */
export function liveOpenThreads(discussions: MrDiscussion[]): Array<{
  finding: string; severity: ReviewSeverity; discussionId: string; noteId: number; file: string | null; line: number | null;
}> {
  const out: ReturnType<typeof liveOpenThreads> = [];
  for (const d of discussions) {
    const first = d.notes[0];
    const m = parseMarker(first?.body);
    if (!first || m?.role !== 'reviewer' || m.action !== 'raised' || !discussionOpen(d)) continue;
    out.push({
      finding: m.finding, severity: m.severity ?? 'major', discussionId: d.id, noteId: first.id,
      file: first.position?.new_path ?? first.position?.old_path ?? null,
      line: first.position?.new_line ?? first.position?.old_line ?? null,
    });
  }
  return out;
}

/**
 * Fix laps already spent in the current review: the fixer's laps since the
 * code last changed OUTSIDE the loop.
 *
 * Counted from the last successful `implement`, because that is when the
 * reviewer was handed something new to read — a first build, a verify fix, a
 * round of a person's MR comments — and each of those deserves its own laps
 * rather than whatever an earlier review left over. The old loop shared one
 * budget across the whole run: by the time #9174's verify fix was re-reviewed
 * the budget was already spent, so its findings went straight to a merge that
 * refused them. An infra death is not a lap: the fixer never got to answer.
 */
export function fixLapsUsed(
  phases: Array<{ phase: string; status: string; startedAt: number; endedAt: number }>,
): number {
  let since = 0;
  for (const p of phases) {
    if (p.phase === 'implement' && (p.status === 'ok' || p.status === 'warned')) since = Math.max(since, p.endedAt);
  }
  return phases.filter((p) => p.phase === 'review-fix' && p.status !== 'infra' && p.startedAt >= since).length;
}

/**
 * The review as every other phase reads it: findings.json.
 *
 * That file used to be whatever the last reviewer session returned, and a
 * verdict that outlived the fix it asked for went on refusing the merge. It is
 * now a VIEW the conductor rewrites from the ledger after every step: the
 * verdict is 'changes-requested' exactly while a blocker or major is open, and
 * `findings` lists what is still open and nothing else. So `mr` describes the
 * review as it stands, a later `implement` lap is not handed threads the fixer
 * already owns, and the old merge gate would reach the same answer as the live
 * one for as long as the two agree about GitLab.
 */
export function reviewArtifact(l: ReviewLedger | null, summary: string): Record<string, unknown> {
  const threads = l?.threads ?? [];
  const open = threads.filter((t) => !t.resolved);
  const tally = (status: string): number => threads.filter((t) => t.status === status).length;
  return {
    summary: l?.reviewSummary ? `${summary} Reviewer: ${l.reviewSummary}` : summary,
    blocked: null,
    verdict: open.some((t) => isBlocking(t.severity)) ? 'changes-requested' : 'approve',
    findings: open.map((t) => ({
      id: t.id, severity: t.severity, file: t.file, line: t.line, what: t.what, why: t.why, fix: t.fix,
    })),
    threads: {
      mrIid: l?.mrIid ?? null,
      raised: threads.length,
      open: open.length,
      fixed: tally('accepted') + tally('fixed'),
      withdrawn: tally('withdrawn'),
      closed: tally('closed'),
      disputed: tally('disputed'),
      droppedOnRecheck: l?.dropped.length ?? 0,
    },
  };
}
