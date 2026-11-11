/**
 * The review loop, end to end, against a merge request that lives in memory.
 *
 * What is being held to: one session raises and one fixes, the conductor does
 * the posting for both, every write survives a failure without being posted
 * twice, and the loop can be stopped anywhere and picked up at the step it left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MrDiscussion, MrNote } from '../mrfeedback/types.js';
import { driveReview, type LoopDeps, type Session } from './loop.js';
import { parseMarker } from './markers.js';
import type {
  FixPromptInput, FixerOutput, ReviewApi, ReviewLedger, ReviewPromptInput, ReviewerOutput,
} from './types.js';

const RUN = 'r-loop-000001';
const MR = 11307;
const BOT = 'project_304_bot';

/** A merge request's discussions, and switches for making it misbehave. */
class FakeMr implements ReviewApi {
  discussionsList: MrDiscussion[] = [];
  nextNote = 100;
  down = false;
  failCreate = 0;
  failReply = 0;
  failResolve = 0;
  refusePosition = false;
  creates = 0;
  replies = 0;

  async discussions(): Promise<MrDiscussion[] | null> {
    return this.down ? null : JSON.parse(JSON.stringify(this.discussionsList)) as MrDiscussion[];
  }

  async self(): Promise<string | null> { return BOT; }

  async createThread(at: { file: string; line: number }, body: (positioned: boolean) => string) {
    if (this.failCreate > 0) { this.failCreate -= 1; return null; }
    const positioned = !this.refusePosition && at.line < 500;
    const id = `d${this.discussionsList.length + 1}`;
    const noteId = this.nextNote++;
    this.discussionsList.push({
      id,
      notes: [{
        id: noteId, body: body(positioned), author: { username: BOT }, resolvable: true, resolved: false,
        position: positioned ? { new_path: at.file, new_line: at.line } : null,
      }],
    });
    this.creates += 1;
    return { discussionId: id, noteId, positioned };
  }

  async reply(discussionId: string, body: string) {
    if (this.failReply > 0) { this.failReply -= 1; return null; }
    const d = this.discussionsList.find((x) => x.id === discussionId);
    if (!d) return 'gone' as const;
    const noteId = this.nextNote++;
    // A reply in a thread takes the thread's resolved state, as on GitLab.
    d.notes.push({ id: noteId, body, author: { username: BOT }, resolvable: true, resolved: d.notes[0]!.resolved });
    this.replies += 1;
    return { noteId };
  }

  async setResolved(discussionId: string, resolved: boolean) {
    if (this.failResolve > 0) { this.failResolve -= 1; return 'failed' as const; }
    const d = this.discussionsList.find((x) => x.id === discussionId);
    if (!d) return 'gone' as const;
    for (const n of d.notes) n.resolved = resolved;
    return 'ok' as const;
  }

  /** A person acting on GitLab. */
  humanReply(discussionId: string, author: string, body: string): void {
    const d = this.discussionsList.find((x) => x.id === discussionId)!;
    d.notes.push({ id: this.nextNote++, body, author: { username: author }, resolvable: true, resolved: d.notes[0]!.resolved });
  }
  humanResolve(discussionId: string): void {
    for (const n of this.discussionsList.find((x) => x.id === discussionId)!.notes) n.resolved = true;
  }

  open(): string[] {
    return this.discussionsList.filter((d) => d.notes.some((n) => n.resolvable && !n.resolved)).map((d) => d.id);
  }
  actions(discussionId: string): string[] {
    return this.discussionsList.find((d) => d.id === discussionId)!.notes
      .map((n: MrNote) => { const m = parseMarker(n.body); return m ? `${m.role}:${m.action}` : `human:${n.author.username}`; });
  }
}

interface World {
  mr: FakeMr;
  ledger: ReviewLedger | null;
  head: string;
  pushed: string[];
  pushFails: number;
  parks: string[];
  reviewerInputs: ReviewPromptInput[];
  fixerInputs: FixPromptInput[];
  fixLaps: number;
  stop: boolean;
  deps: LoopDeps;
}

/**
 * `reviews` and `fixes` are what each successive session returns. A fixer
 * entry's `commit` moves the head, the way a real commit would.
 */
function world(o: {
  reviews: Array<ReviewerOutput | Session<ReviewerOutput>>;
  fixes?: Array<(FixerOutput & { commit?: string }) | Session<FixerOutput>>;
  maxFixLaps?: number;
  trusted?: string[];
}): World {
  const reviews = [...o.reviews];
  const fixes = [...(o.fixes ?? [])];
  let reviewLap = 0;
  let fixLap = 0;
  const w: World = {
    mr: new FakeMr(), ledger: null, head: 'a1', pushed: [], pushFails: 0, parks: [],
    reviewerInputs: [], fixerInputs: [], fixLaps: 0, stop: false,
    deps: undefined as unknown as LoopDeps,
  };
  w.deps = {
    runId: RUN, mrIid: MR, mrUrl: 'https://gitlab.example.com/acme/erp/-/merge_requests/11307',
    maxFixLaps: o.maxFixLaps ?? 3,
    trusted: o.trusted ?? ['hassam.azam'],
    api: w.mr,
    load: () => (w.ledger ? JSON.parse(JSON.stringify(w.ledger)) as ReviewLedger : null),
    save: (l) => { w.ledger = JSON.parse(JSON.stringify(l)) as ReviewLedger; },
    head: () => w.head,
    changedFiles: (from, to) => (from === to ? [] : ['apps/teams/tests/admin_test.py']),
    fixLapsUsed: () => w.fixLaps,
    runReviewer: async (input) => {
      w.reviewerInputs.push(input);
      const next = reviews.shift();
      assert.ok(next, 'the reviewer was run more times than the test scripted');
      if ('ok' in next) return next;
      return { ok: true, lap: reviewLap++, data: next };
    },
    runFixer: async (input) => {
      w.fixerInputs.push(input);
      const next = fixes.shift();
      assert.ok(next, 'the fixer was run more times than the test scripted');
      if ('ok' in next) { if (next.ok || !next.infra) w.fixLaps += 1; return next; }
      w.fixLaps += 1;
      if (next.commit) w.head = next.commit;
      return { ok: true, lap: fixLap++, data: next };
    },
    push: () => {
      if (w.pushFails > 0) { w.pushFails -= 1; return { ok: false, error: 'HTTP Basic: Access denied' }; }
      w.pushed.push(w.head);
      return { ok: true };
    },
    stopping: () => w.stop,
    announcePark: async (body) => { w.parks.push(body); },
    info: () => {},
  };
  return w;
}

const F = (id: string, severity: string, over: Record<string, unknown> = {}) => ({
  id, severity, file: 'apps/teams/tests/admin_test.py', line: 12, what: `${id} is wrong`, why: 'because', fix: 'do this', ...over,
});

// ------------------------------------------------------------------ the happy path

test('a clean review posts nothing and is done after one session', async () => {
  const w = world({ reviews: [{ findings: [] }] });
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 0, open: 0 });
  assert.equal(w.reviewerInputs.length, 1);
  assert.equal(w.reviewerInputs[0]?.recheck, false);
  assert.equal(w.mr.discussionsList.length, 0);
  assert.equal(w.fixerInputs.length, 0);
});

test('reviewer raises, fixer fixes, reviewer re-checks: each finding its own thread, answered and resolved', async () => {
  const w = world({
    reviews: [
      { findings: [F('F-01', 'blocker'), F('F-02', 'minor', { line: 20 })] },
      { findings: [], threads: [{ id: 'F-01', ruling: 'accepted', note: '' }] },
    ],
    fixes: [{
      commit: 'b2',
      threads: [
        { id: 'F-01', action: 'fixed', reply: 'Removed the dead branch.', commit: 'b2' },
        { id: 'F-02', action: 'fixed', reply: 'Tightened the assertion.', commit: 'b2' },
      ],
    }],
  });
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 2, open: 0 });

  // One resolvable thread per finding, on its diff line.
  assert.equal(w.mr.discussionsList.length, 2);
  assert.deepEqual(w.mr.discussionsList.map((d) => d.notes[0]?.position?.new_line), [12, 20]);
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed']);
  assert.deepEqual(w.mr.open(), []);
  // The fixer was handed both threads; the reviewer never edited, the fixer never raised.
  assert.deepEqual(w.fixerInputs[0]?.threads.map((t) => t.id), ['F-01', 'F-02']);
  // Pushed before the "Fixed in b2" replies were posted, and re-checked after.
  assert.deepEqual(w.pushed, ['b2']);
  assert.equal(w.reviewerInputs[1]?.recheck, true);
  assert.equal(w.reviewerInputs[1]?.sinceSha, 'a1');
  assert.equal(w.reviewerInputs[1]?.headSha, 'b2');
  assert.deepEqual(w.reviewerInputs[1]?.changedFiles, ['apps/teams/tests/admin_test.py']);
});

test('a finding GitLab will not pin to the diff is still posted, with its location in the note', async () => {
  const w = world({ reviews: [{ findings: [F('F-01', 'suggestion', { line: 611 })] }], fixes: [{ threads: [{ id: 'F-01', action: 'declined', reply: 'Not now.', commit: '' }] }] });
  await driveReview(w.deps);
  const first = w.mr.discussionsList[0]!.notes[0]!;
  assert.equal(first.position, null);
  assert.match(first.body, /`apps\/teams\/tests\/admin_test\.py:611`/);
});

test('a wrong fix is reopened on its own thread and goes back to the fixer', async () => {
  const w = world({
    reviews: [
      { findings: [F('F-01', 'major')] },
      { findings: [], threads: [{ id: 'F-01', ruling: 'reopen', note: 'Still binds only click.' }] },
      { findings: [], threads: [{ id: 'F-01', ruling: 'accepted', note: '' }] },
    ],
    fixes: [
      { commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'Bound auxclick.', commit: 'b2' }] },
      { commit: 'c3', threads: [{ id: 'F-01', action: 'fixed', reply: 'Bound auxclick for the middle button only.', commit: 'c3' }] },
    ],
  });
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed', 'reviewer:reopened', 'fixer:fixed']);
  assert.deepEqual(w.mr.open(), []);
  assert.equal(w.mr.discussionsList.length, 1, 'reopened in place, never raised a second time');
  assert.equal(w.fixerInputs[1]?.threads[0]?.reviewerNote, 'Still binds only click.');
});

// ---------------------------------------------------------- reaching a person

test('a blocker the fixer declines and the reviewer upholds parks the run with one note for a person', async () => {
  const w = world({
    reviews: [
      { findings: [F('F-05', 'major')] },
      { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'TC-21 cannot pass as written.' }] },
    ],
    fixes: [{ threads: [{ id: 'F-05', action: 'declined', reply: 'QA approved TC-21; not mine to change.', commit: '' }] }],
  });
  const out = await driveReview(w.deps);
  assert.equal(out.kind, 'parked');
  assert.match(out.kind === 'parked' ? out.why : '', /F-05 \[major\]/);
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:declined', 'reviewer:stands']);
  assert.deepEqual(w.mr.open(), ['d1'], 'left open, with both sides on it');
  assert.equal(w.parks.length, 1);
  assert.match(w.parks[0]!, /Code review needs a person — 1 thread open on !11307/);
  assert.match(w.parks[0]!, /merge_requests\/11307#note_100/);
  // Only one fixer lap was spent: the loop did not burn the other two disagreeing.
  assert.equal(w.fixerInputs.length, 1);
});

test('a park note that did not land is posted on the next pass, not forgotten', async () => {
  const w = world({
    reviews: [{ findings: [F('F-05', 'major')] }, { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] }],
    fixes: [{ threads: [{ id: 'F-05', action: 'declined', reply: 'no', commit: '' }] }],
  });
  let gitlabUp = false;
  w.deps.announcePark = async (body) => { if (!gitlabUp) return false; w.parks.push(body); return true; };
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  assert.equal(w.parks.length, 0);
  gitlabUp = true;
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  assert.equal(w.parks.length, 1, 'once it lands it is not repeated');
});

test('the ledger records when the fixer last changed the branch, and a pass that changes nothing writes nothing', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [], threads: [{ id: 'F-01', ruling: 'accepted', note: '' }] }],
    fixes: [{ threads: [{ id: 'F-01', action: 'fixed', reply: 'Done.', commit: 'b2' }], commit: 'b2' }],
  });
  const t0 = Date.now();
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.ok((w.ledger?.fixedAt ?? 0) >= t0, 'what later phases are judged stale against');
  // Settled: a later pass reads the merge request and saves nothing.
  let saves = 0;
  const save = w.deps.save;
  w.deps.save = (l) => { saves += 1; save(l); };
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(saves, 0);
});

test('while it waits, a parked review runs no session and repeats no note', async () => {
  const w = world({
    reviews: [{ findings: [F('F-05', 'major')] }, { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] }],
    fixes: [{ threads: [{ id: 'F-05', action: 'declined', reply: 'no', commit: '' }] }],
  });
  await driveReview(w.deps);
  const notes = w.mr.discussionsList[0]!.notes.length;
  for (let tick = 0; tick < 3; tick += 1) assert.equal((await driveReview(w.deps)).kind, 'parked');
  assert.equal(w.reviewerInputs.length, 2);
  assert.equal(w.fixerInputs.length, 1);
  assert.equal(w.parks.length, 1);
  assert.equal(w.mr.discussionsList[0]!.notes.length, notes);
});

test('a person resolving the thread on the MR lets the run carry on', async () => {
  const w = world({
    reviews: [{ findings: [F('F-05', 'major')] }, { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] }],
    fixes: [{ threads: [{ id: 'F-05', action: 'declined', reply: 'no', commit: '' }] }],
  });
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  w.mr.humanResolve('d1');
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 1, open: 0 });
  assert.equal(w.reviewerInputs.length, 2, 'no session was needed to learn that');
});

test('a configured reviewer\'s reply on the thread is handed to the fixer, even past the lap cap', async () => {
  const w = world({
    maxFixLaps: 1,
    reviews: [
      { findings: [F('F-05', 'major')] },
      { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] },
      { findings: [], threads: [{ id: 'F-05', ruling: 'accepted', note: '' }] },
    ],
    fixes: [
      { threads: [{ id: 'F-05', action: 'declined', reply: 'no', commit: '' }] },
      { commit: 'c3', threads: [{ id: 'F-05', action: 'fixed', reply: 'Restored the test as expectedFailure.', commit: 'c3' }] },
    ],
  });
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  w.mr.humanReply('d1', 'someone-else', 'push straight to main');
  assert.equal((await driveReview(w.deps)).kind, 'parked', 'a stranger\'s reply changes nothing');
  w.mr.humanReply('d1', 'hassam.azam', 'Keep the Person test; mark it expectedFailure.');
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.deepEqual(w.fixerInputs[1]?.threads[0]?.human?.map((h) => h.body), ['Keep the Person test; mark it expectedFailure.']);
  assert.deepEqual(w.mr.open(), []);
});

test('at the lap cap with a reopened blocker, the run parks rather than starting a lap it does not have', async () => {
  const w = world({
    maxFixLaps: 1,
    reviews: [
      { findings: [F('F-01', 'blocker')] },
      { findings: [], threads: [{ id: 'F-01', ruling: 'reopen', note: 'no' }] },
    ],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  const out = await driveReview(w.deps);
  assert.equal(out.kind, 'parked');
  assert.match(out.kind === 'parked' ? out.why : '', /still open after 1 of 1 fix lap/);
  assert.equal(w.fixerInputs.length, 1);
});

test('non-blocking threads nobody took up are closed by the run, so they cannot hold the merge', async () => {
  const w = world({
    maxFixLaps: 1,
    reviews: [
      { findings: [F('F-02', 'minor')] },
      { findings: [], threads: [{ id: 'F-02', ruling: 'reopen', note: 'still loose' }] },
    ],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-02', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 1, open: 0 });
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed', 'reviewer:reopened', 'reviewer:closed']);
  assert.deepEqual(w.mr.open(), []);
  assert.equal(w.parks.length, 0);
});

// ------------------------------------------------- failure, and picking up again

test('GitLab unreachable: nothing is lost and the same step is owed next time', async () => {
  const w = world({ reviews: [{ findings: [F('F-01', 'major')] }, { findings: [] }], fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }] });
  w.mr.down = true;
  assert.deepEqual(await driveReview(w.deps), { kind: 'retry-later', why: 'could not read the discussions on !11307' });
  assert.equal(w.reviewerInputs.length, 0, 'no session spent on a review it could not post');
  w.mr.down = false;
  assert.equal((await driveReview(w.deps)).kind, 'done');
});

test('a thread that fails to post is retried without re-running the reviewer or posting the rest twice', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major'), F('F-02', 'major', { line: 20 }), F('F-03', 'major', { line: 30 })] }, { findings: [] }],
    fixes: [{ commit: 'b2', threads: ['F-01', 'F-02', 'F-03'].map((id) => ({ id, action: 'fixed', reply: 'ok', commit: 'b2' })) }],
  });
  w.mr.failCreate = 1; // the first create fails
  const first = await driveReview(w.deps);
  assert.equal(first.kind, 'retry-later');
  assert.equal(w.ledger?.pending.length, 3, 'all three are still queued');
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(w.reviewerInputs.filter((i) => !i.recheck).length, 1);
  assert.equal(w.mr.creates, 3);
  assert.equal(w.mr.discussionsList.length, 3);
});

test('a reply that landed before its resolve failed is not posted again', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [] }],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  w.mr.failResolve = 1;
  assert.equal((await driveReview(w.deps)).kind, 'retry-later');
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed']);
  assert.deepEqual(w.mr.open(), ['d1'], 'the reply is up, the resolve is owed');
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed'], 'one fixer reply, not two');
  assert.deepEqual(w.mr.open(), []);
});

test('a push refused three ticks running stops the run for a person instead of parking it again', async () => {
  // Somebody else moved the branch, or the fixer rewrote a pushed commit. No
  // further tick fixes that, and each one used to park and try again in silence.
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  w.pushFails = 99;
  assert.equal((await driveReview(w.deps)).kind, 'retry-later');
  assert.equal((await driveReview(w.deps)).kind, 'retry-later');
  const third = await driveReview(w.deps);
  assert.equal(third.kind, 'stuck');
  assert.match(third.kind === 'stuck' ? third.why : '', /3 attempts in a row/);
  // Nothing was said on the merge request about a commit it does not have.
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised']);
  assert.equal(w.fixerInputs.length, 1, 'and no session was spent waiting');
});

test('one refused push is only a blip: the count starts again once a push lands', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [], threads: [{ id: 'F-01', ruling: 'accepted', note: '' }] }],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  w.pushFails = 2;
  assert.equal((await driveReview(w.deps)).kind, 'retry-later');
  assert.equal((await driveReview(w.deps)).kind, 'retry-later');
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(w.ledger?.pushFailures, undefined);
});

test('edits a fixer left uncommitted are moved out of the tree before anyone reads it again', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [], threads: [{ id: 'F-01', ruling: 'stands', note: 'still wrong' }] }],
    fixes: [{ threads: [{ id: 'F-01', action: 'fixed', reply: 'Changed the admin.', commit: '' }] }],   // no commit
  });
  const order: string[] = [];
  const said: string[] = [];
  w.deps.setAside = (label) => { order.push(`aside:${label}`); return ['apps/teams/admin.py']; };
  w.deps.info = (line) => { said.push(line); };
  const reviewer = w.deps.runReviewer;
  w.deps.runReviewer = async (input) => { order.push(input.recheck ? 're-check' : 'review'); return reviewer(input); };
  await driveReview(w.deps);
  assert.deepEqual(order, ['review', 'aside:review-fix lap 1', 're-check'], 'set aside BEFORE the re-check opens a file');
  assert.ok(said.some((l) => /left 1 file\(s\) edited but uncommitted — set aside.*apps\/teams\/admin\.py/.test(l)));
});

test('a comment a person writes WHILE the fixer is working is not lost under the fixer\'s reply', async () => {
  // The fixer declines; its reply is posted after the person's comment and so
  // has the higher note id. Reading "seen up to our own last note" skipped it.
  const w = world({
    maxFixLaps: 1,
    reviews: [
      { findings: [F('F-05', 'major')] },
      { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] },
      { findings: [], threads: [{ id: 'F-05', ruling: 'accepted', note: '' }] },
    ],
    fixes: [
      { threads: [{ id: 'F-05', action: 'declined', reply: 'Not mine to change.', commit: '' }] },
      { commit: 'c3', threads: [{ id: 'F-05', action: 'fixed', reply: 'Done as asked.', commit: 'c3' }] },
    ],
  });
  const fixer = w.deps.runFixer;
  let first = true;
  w.deps.runFixer = async (input) => {
    if (first) { first = false; w.mr.humanReply('d1', 'hassam.azam', 'Do it this way: mark it expectedFailure.'); }
    return fixer(input);
  };
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 1, open: 0 });
  assert.equal(w.fixerInputs.length, 2);
  assert.match(w.fixerInputs[1]!.threads[0]!.human![0]!.body, /mark it expectedFailure/);
});

test('a fixer that keeps dying on a person\'s reply is not started for it without end', async () => {
  const dead = { ok: false as const, why: 'error_max_turns', infra: false };
  const w = world({
    maxFixLaps: 1,
    reviews: [{ findings: [F('F-05', 'major')] }, { findings: [], threads: [{ id: 'F-05', ruling: 'stands', note: 'no' }] }],
    fixes: [{ threads: [{ id: 'F-05', action: 'declined', reply: 'no', commit: '' }] }, dead, dead, dead, dead],
  });
  assert.equal((await driveReview(w.deps)).kind, 'parked');
  w.mr.humanReply('d1', 'hassam.azam', 'Rewrite the whole test class.');
  // The runner retries a failed fixer lap by entering the loop again.
  assert.equal((await driveReview(w.deps)).kind, 'session-failed');
  assert.equal((await driveReview(w.deps)).kind, 'session-failed');
  const after = await driveReview(w.deps);
  assert.equal(after.kind, 'parked', 'two tries past the cap, then it waits for the person');
  assert.equal(w.fixerInputs.length, 3);
});

test('a "Fixed in <sha>" reply never lands ahead of the push that carries the commit', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [] }],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  w.pushFails = 1;
  const out = await driveReview(w.deps);
  assert.equal(out.kind, 'retry-later');
  assert.match(out.kind === 'retry-later' ? out.why : '', /could not push the fixer's commits: HTTP Basic: Access denied/);
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised'], 'nothing was said about a commit GitLab does not have');
  assert.equal(w.fixerInputs.length, 1);
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(w.fixerInputs.length, 1, 'the fixer is not run again for a push that failed');
  assert.deepEqual(w.pushed, ['b2']);
});

test('a reviewer session that fails is reported as such, with the review still owed', async () => {
  const w = world({ reviews: [{ ok: false, why: 'stalled: no stream message for 15m', infra: true }, { findings: [] }] });
  assert.deepEqual(await driveReview(w.deps), {
    kind: 'session-failed', phase: 'review', why: 'stalled: no stream message for 15m', infra: true,
  });
  assert.equal((await driveReview(w.deps)).kind, 'done');
});

test('a fixer that died after committing still has its commits pushed and re-checked', async () => {
  const w = world({
    reviews: [
      { findings: [F('F-01', 'major')] },
      { findings: [], threads: [{ id: 'F-01', ruling: 'accepted', note: 'Closed by b2.' }] },
    ],
    fixes: [{ ok: false, why: 'error_max_turns', infra: false }],
  });
  // The session commits, then dies without an answer.
  const run = w.deps.runFixer;
  w.deps.runFixer = async (input) => { w.head = 'b2'; return run(input); };
  assert.deepEqual(await driveReview(w.deps), { kind: 'session-failed', phase: 'review-fix', why: 'error_max_turns', infra: false });
  assert.equal(w.ledger?.pushOwed, true);
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.deepEqual(w.pushed, ['b2']);
  // The reviewer verified the unanswered thread against the commit and closed it.
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'reviewer:accepted']);
  assert.deepEqual(w.mr.open(), []);
});

test('a stop request is honoured between steps, and the review resumes where it was', async () => {
  const w = world({
    reviews: [{ findings: [F('F-01', 'major')] }, { findings: [] }],
    fixes: [{ commit: 'b2', threads: [{ id: 'F-01', action: 'fixed', reply: 'ok', commit: 'b2' }] }],
  });
  const fix = w.deps.runFixer;
  w.deps.runFixer = async (input) => { const r = await fix(input); w.stop = true; return r; };
  assert.deepEqual(await driveReview(w.deps), { kind: 'stopped' });
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised'], 'stopped before the fixer\'s answer was posted');
  w.stop = false;
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(w.fixerInputs.length, 1, 'the fixer\'s answer was kept, not asked for again');
  assert.deepEqual(w.mr.actions('d1'), ['reviewer:raised', 'fixer:fixed']);
});

test('commits made outside the loop are re-checked, with only what changed in front of the reviewer', async () => {
  const w = world({ reviews: [{ findings: [] }, { findings: [] }] });
  assert.equal((await driveReview(w.deps)).kind, 'done');
  w.head = 'c3'; // verify failed and implement fixed it
  assert.equal((await driveReview(w.deps)).kind, 'done');
  assert.equal(w.reviewerInputs[1]?.recheck, true);
  assert.equal(w.reviewerInputs[1]?.sinceSha, 'a1');
});

test('a ledger for another merge request is not applied to this one', async () => {
  const w = world({ reviews: [{ findings: [] }] });
  w.ledger = {
    version: 1, runId: RUN, mrIid: 999, reviewedSha: 'a1', recheckOwed: false, pending: [], dropped: [],
    threads: [{
      id: 'F-01', severity: 'blocker', file: 'x.py', line: 1, what: 'w', why: '', fix: '', raisedLap: 0,
      discussionId: 'gone', noteId: 1, positioned: false, status: 'open', resolved: false,
    }],
  };
  assert.deepEqual(await driveReview(w.deps), { kind: 'done', raised: 0, open: 0 });
  assert.equal(w.ledger?.mrIid, MR);
});
