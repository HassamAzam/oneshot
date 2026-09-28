/**
 * The Ready For Automation state machine, tally and session classification —
 * the pure half of runner.ts. Nothing here reaches GitLab, the sheet or a
 * session: the I/O steps are thin over these decisions, and these are the
 * decisions that would silently post twice, approve the wrong version, or pay
 * for a session nobody needed if they drifted.
 *
 * Every iid, note id and MR number is invented.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Issue, IssueNote } from '../lib/gitlab.js';
import { CANCELLED_BY_CONDUCTOR, NO_STRUCTURED_OUTPUT, type PhaseOutput } from '../conductor/phase.js';
import type { AutomationJournal, VersionRecord } from './journal.js';
import {
  AUTOMATION_DENY, blockedBeforeModel, hookCallbackFailed, isNearApproval, nextStep, outcomeLine, reviewVerdict,
  scanFilter, sessionCharge, stuckReleased,
} from './runner.js';

const TRIGGER = 'Ready For Automation';
const DONE = 'Automation Done';
const PROJECT = 'gitlab.example.com/acme/erp';
const RECHECK = 30 * 60_000;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const APPROVERS = ['anosha.saeed', 'arsal.tariq'];

function issue(over: Partial<Issue> = {}): Issue {
  return {
    iid: 101, title: 'Profile preferences', description: '', labels: [TRIGGER], assignees: [],
    state: 'closed', web_url: 'https://gitlab.example.com/acme/erp/-/issues/101', updated_at: '2026-09-28T10:00:00Z',
    ...over,
  };
}

function journal(over: Partial<AutomationJournal> = {}): AutomationJournal {
  return {
    v: 1, iid: 101, runId: 'a-test-000000', project: PROJECT, title: 'Profile preferences', state: 'new',
    createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, notReadyPosted: [], attempts: 0, sessions: 0,
    freeRetries: 0, versions: [], watermark: 0, feedbackRounds: [],
    ...over,
  };
}

function version(over: Partial<VersionRecord> = {}): VersionRecord {
  return {
    v: 1, module: 'Profile', count: 8, hash: 'abcdef012345', noteId: 500, postedAt: NOW - 60_000,
    reviewLabelled: true, changes: [], ...over,
  };
}

const opts = { trigger: TRIGGER, done: DONE, recheckMs: RECHECK, now: NOW, project: PROJECT };

function step(j: AutomationJournal | null, i: Partial<Issue> = {}) {
  const x = issue(i);
  return nextStep(j, { labels: x.labels, updated_at: x.updated_at }, opts);
}

function note(id: number, user: string, body: string, over: Partial<IssueNote> = {}): IssueNote {
  return { id, body, author: { username: user }, created_at: `2026-09-28T10:${String(id % 60).padStart(2, '0')}:00Z`, ...over };
}

function out(over: Partial<PhaseOutput> = {}): PhaseOutput {
  return {
    ok: false, data: null, blocked: null, summary: '', turns: 0, weighted: 0, sessionId: '', rateLimited: false, ...over,
  };
}

// ---------------------------------------------------------------- scan

test('the scan keeps open and closed tickets from any assignee and drops Automation Done', () => {
  const { candidates, skipped } = scanFilter([
    issue({ iid: 101, state: 'closed', assignees: [{ username: 'someone.else' }] }),
    issue({ iid: 102, state: 'opened', assignees: [] }),
    issue({ iid: 103, labels: [TRIGGER, DONE] }),
    issue({ iid: 104, labels: ['Loop'] }),
    issue({ iid: 101 }),
  ], { trigger: TRIGGER, done: DONE });
  assert.deepEqual(candidates.map((i) => i.iid), [101, 102]);
  assert.deepEqual(skipped.map((s) => s.iid), [103, 104]);
  assert.match(skipped[0]!.why, /Automation Done/);
});

// ---------------------------------------------------------------- nextStep

test('nextStep: a new ticket is checked', () => {
  assert.deepEqual(step(null), { kind: 'check', reason: 'first' });
  assert.deepEqual(step(journal({ state: 'new' })), { kind: 'check', reason: 'first' });
});

test('nextStep: a not-ready ticket waits until it changes or the cadence passes', () => {
  const readiness = {
    verdict: 'not-ready' as const, at: NOW - 10 * 60_000, issueUpdatedAt: '2026-09-28T10:00:00Z',
    fingerprint: '0123456789ab', merged: [], open: [],
  };
  const j = journal({ state: 'not-ready', readiness });
  assert.equal(step(j).kind, 'hold');
  assert.deepEqual(step(j, { updated_at: '2026-09-28T11:30:00Z' }), { kind: 'check', reason: 'changed' });
  const old = journal({ state: 'not-ready', readiness: { ...readiness, at: NOW - RECHECK } });
  assert.deepEqual(step(old), { kind: 'check', reason: 'cadence' });
});

test('nextStep: ready means WRITE, and pending feedback means REVISE', () => {
  assert.deepEqual(step(journal({ state: 'authoring' })), { kind: 'author', mode: 'write' });
  const pendingFeedback = { afterVersion: 1, notes: [{ id: 610, author: 'anosha.saeed', body: 'drop TC-03' }], ignoredApproval: false };
  assert.deepEqual(step(journal({ state: 'authoring', versions: [version()], pendingFeedback })), { kind: 'author', mode: 'revise' });
  // A posted version with nothing asked of it is never rewritten from scratch.
  assert.deepEqual(step(journal({ state: 'authoring', versions: [version()] })), { kind: 'review' });
});

test('nextStep: a saved but unposted version is posted before anything else; a posted but unlabelled one gets the review label next', () => {
  const unposted = version({ v: 2, noteId: null, postedAt: null, reviewLabelled: false });
  assert.deepEqual(step(journal({ state: 'in-review', versions: [version(), unposted] })), { kind: 'post', v: 2 });
  // Even while authoring: the version exists, so it is posted rather than written again.
  assert.deepEqual(step(journal({ state: 'authoring', versions: [unposted] })), { kind: 'post', v: 2 });
  const unlabelled = version({ reviewLabelled: false });
  assert.deepEqual(step(journal({ state: 'in-review', versions: [unlabelled] })), { kind: 'label-review', v: 1 });
  assert.deepEqual(step(journal({ state: 'in-review', versions: [version()] })), { kind: 'review' });
});

test('nextStep: a version posted in DRY_RUN (postedAt set, noteId null) is not posted again', () => {
  const dry = version({ noteId: null, postedAt: NOW - 1000, reviewLabelled: false });
  assert.deepEqual(step(journal({ state: 'in-review', versions: [dry] })), { kind: 'label-review', v: 1 });
  assert.deepEqual(step(journal({ state: 'in-review', versions: [{ ...dry, reviewLabelled: true }] })), { kind: 'review' });
});

test('nextStep: approved means sheet; done is skipped; a flipped ticket owing its done note gets done-note even with Automation Done', () => {
  const approval = { version: 1, by: 'anosha.saeed', noteId: 620, at: '2026-09-28T10:20:00Z' };
  assert.deepEqual(step(journal({ state: 'approved', versions: [version()], approval })), { kind: 'sheet' });

  const done = step(journal({ state: 'done', versions: [version()], approval }), { labels: [TRIGGER, DONE] });
  assert.equal(done.kind, 'skip');
  assert.match((done as { why: string }).why, /already Automation Done — nothing to do/);
  const undone = step(journal({ state: 'done', versions: [version()], approval }));
  assert.equal(undone.kind, 'skip');
  assert.match((undone as { why: string }).why, /finished earlier/);

  const owes = journal({ state: 'approved', versions: [version()], approval, labelsDone: true, donePostedAt: null });
  assert.deepEqual(step(owes, { labels: [TRIGGER, DONE] }), { kind: 'done-note' });
  // Automation Done added by a human, with nothing owed: stop.
  assert.equal(step(journal({ state: 'in-review', versions: [version()] }), { labels: [TRIGGER, DONE] }).kind, 'skip');
});

test('nextStep: a journal from another project starts fresh', () => {
  const foreign = journal({ state: 'done', project: 'gitlab.example.com/acme/other', versions: [version()] });
  assert.deepEqual(step(foreign), { kind: 'check', reason: 'first' });
});

test('nextStep: stuck polls, whatever else the journal holds', () => {
  const stuck = { at: NOW, reason: 'x', fp: '0123456789ab', notePostedAt: null, sinceNoteId: null };
  assert.deepEqual(step(journal({ state: 'stuck', stuck })), { kind: 'stuck-poll' });
});

// ---------------------------------------------------------------- the tally

const tally = (notes: IssueNote[], watermark = 500, versionNoteId = 500) =>
  reviewVerdict(notes, { watermark, versionNoteId, approvers: APPROVERS });

test('reviewVerdict: only QA approvers after the watermark count', () => {
  assert.equal(tally([note(490, 'anosha.saeed', 'approved')]).verdict, 'pending');
  assert.equal(tally([note(500, 'anosha.saeed', 'approved')]).verdict, 'pending');
  const v = tally([note(510, 'arsal.tariq', 'approved')]);
  assert.equal(v.verdict, 'approved');
  assert.deepEqual(v.verdict === 'approved' && { by: v.by, noteId: v.noteId, at: v.at },
    { by: 'arsal.tariq', noteId: 510, at: '2026-09-28T10:30:00Z' });
});

test("reviewVerdict: system, machine and 'Oneshot '-prefixed notes never count, even from an approver's token", () => {
  const v = tally([
    note(510, 'arsal.tariq', 'added ~12 label', { system: true }),
    note(511, 'arsal.tariq', '**Automation test cases: v1**\n\n<!-- oneshot:automation:cases:v1:abcdef012345 -->'),
    note(512, 'arsal.tariq', 'Oneshot stopped: the plan gate is waiting'),
    note(513, 'arsal.tariq', 'Oneshot record: approved test cases'),
  ]);
  assert.deepEqual(v, { verdict: 'pending', staleApprovers: [] });
});

test("reviewVerdict: a bare approved approves; 'approved, but…' is a change request", () => {
  assert.equal(tally([note(510, 'anosha.saeed', '  Approved \n')]).verdict, 'approved');
  const v = tally([note(510, 'anosha.saeed', 'approved, but TC-03 should expect a 403')]);
  assert.equal(v.verdict, 'revise');
  assert.ok(v.verdict === 'revise' && !v.nearApprovalOnly && v.notes[0]!.body.startsWith('approved, but'));
});

test('reviewVerdict: a change request in the same round outweighs approved', () => {
  const v = tally([
    note(510, 'arsal.tariq', 'approved'),
    note(511, 'anosha.saeed', 'drop TC-07'),
  ]);
  assert.equal(v.verdict, 'revise');
  assert.ok(v.verdict === 'revise');
  assert.equal(v.ignoredApproval, true);
  assert.equal(v.maxId, 511);
  assert.deepEqual(v.notes, [{ id: 511, author: 'anosha.saeed', body: 'drop TC-07' }]);
});

test("reviewVerdict: an outsider's approved is ignored", () => {
  assert.deepEqual(tally([note(510, 'usman.nasir', 'approved')]), { verdict: 'pending', staleApprovers: [] });
  // And an outsider's comment is not a change request either.
  assert.equal(tally([note(510, 'usman.nasir', 'please add a case')]).verdict, 'pending');
});

test('reviewVerdict: a change request posted while a REVISE ran is read after the new version, and an approved from that window is stale', () => {
  // Round 1 (ids ≤ 520) was consumed into v2; v2's note is 540. While the
  // session ran, an approver asked for more (530) and another approved v1 (535).
  const notes = [
    note(530, 'arsal.tariq', 'also check the setting survives a reload'),
    note(535, 'anosha.saeed', 'approved'),
    note(540, 'arsal.tariq', '**Automation test cases: v2**\n\n<!-- oneshot:automation:cases:v2:0123456789ab -->'),
  ];
  const v = tally(notes, 520, 540);
  assert.equal(v.verdict, 'revise');
  assert.ok(v.verdict === 'revise');
  assert.deepEqual(v.notes.map((n) => n.id), [530]);
  assert.equal(v.ignoredApproval, false, 'the approval in that window approved v1, not v2');
  assert.equal(v.maxId, 535);

  const staleOnly = tally([note(535, 'anosha.saeed', 'approved'), notes[2]!], 520, 540);
  assert.deepEqual(staleOnly, { verdict: 'pending', staleApprovers: ['anosha.saeed'] });
  // The same approver approving AFTER the v2 note approves v2.
  assert.equal(tally([note(545, 'anosha.saeed', 'approved')], 520, 540).verdict, 'approved');
});

test("isNearApproval: 'Approved.', 'approved ✅' and 'Approve' yes; 'approved' and 'approved, but…' no", () => {
  for (const s of ['Approved.', 'approved ✅', 'Approve', '**Approved**', 'APPROVED!!']) assert.equal(isNearApproval(s), true, s);
  for (const s of ['approved', ' Approved ', 'approved, but TC-03', 'not approved', 'approve TC-01 only']) {
    assert.equal(isNearApproval(s), false, s);
  }
  const v = tally([note(510, 'anosha.saeed', 'Approved.'), note(511, 'arsal.tariq', 'approved ✅')]);
  assert.ok(v.verdict === 'revise' && v.nearApprovalOnly);
  // A near-approval asks for nothing, so a bare `approved` beside it still approves.
  const both = tally([note(510, 'anosha.saeed', 'Approved.'), note(511, 'anosha.saeed', 'approved')]);
  assert.equal(both.verdict, 'approved');
});

// ---------------------------------------------------------------- sessions

test('blockedBeforeModel recognises a prompt the hook refused, and not a cancelled session, a zero-frame death or an error_during_execution result', () => {
  const refused = out({ error: NO_STRUCTURED_OUTPUT, sessionId: 'sess-1', turns: 0 });
  assert.equal(blockedBeforeModel(refused), true);
  assert.equal(blockedBeforeModel({ ...refused, turns: 1 }), true, 'tolerates the one-turn shape');
  assert.equal(blockedBeforeModel(out({ error: CANCELLED_BY_CONDUCTOR, infra: true })), false);
  assert.equal(blockedBeforeModel(out({ error: 'Claude Code process exited with code 1', infra: true })), false);
  assert.equal(blockedBeforeModel(out({ error: 'error_during_execution: boom', sessionId: 'sess-1' })), false);
  assert.equal(blockedBeforeModel({ ...refused, weighted: 1200 }), false, 'spent tokens reached the model');
  assert.equal(blockedBeforeModel({ ...refused, turns: 4 }), false);
  assert.equal(blockedBeforeModel({ ...refused, sessionId: '' }), false);
});

test('sessionCharge: cancelled and rate-limited are none, an account notice is account, a hook block and a zero-frame death are free, a timeout after work is charge', () => {
  assert.equal(sessionCharge(out({ error: CANCELLED_BY_CONDUCTOR, infra: true })), 'none');
  assert.equal(sessionCharge(out({ error: 'rate_limit: resets 4pm', rateLimited: true, weighted: 900 })), 'none');
  assert.equal(sessionCharge(out({ error: 'exited', infra: true, accountAction: 'accept the new terms' })), 'account');
  assert.equal(sessionCharge(out({ error: NO_STRUCTURED_OUTPUT, sessionId: 'sess-1' })), 'free');
  assert.equal(sessionCharge(out({ error: 'Claude Code process exited with code 1', infra: true })), 'free');
  assert.equal(sessionCharge(out({ error: 'timed out after 30m while still working', infra: true, weighted: 250_000 })), 'charge');
  assert.equal(sessionCharge(out({ error: 'error_max_turns: ', turns: 80, weighted: 900_000, sessionId: 'sess-1' })), 'charge');
  assert.equal(sessionCharge(out({ ok: false, blocked: 'no diff', data: {}, turns: 9, weighted: 90_000 })), 'charge');
});

test('hookCallbackFailed reads only the CLI stderr lines of the transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-transcript-'));
  try {
    const clean = join(dir, 'clean.jsonl');
    writeFileSync(clean, [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ text: 'Error in hook callback is a phrase' }] } }),
    ].join('\n'));
    assert.equal(hookCallbackFailed(clean), false);
    const swallowed = join(dir, 'swallowed.jsonl');
    writeFileSync(swallowed, `${JSON.stringify({ type: 'cli-stderr', text: 'Error in hook callback hook_0: bad reply' })}\n`);
    assert.equal(hookCallbackFailed(swallowed), true);
    assert.equal(hookCallbackFailed(join(dir, 'missing.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stuckReleased: only a QA approver\'s note newer than sinceNoteId; never with a null sinceNoteId; never in DRY_RUN', () => {
  const stuck = { at: NOW, reason: 'the list was not usable', fp: '0123456789ab', notePostedAt: NOW, sinceNoteId: 700 };
  const retry = [note(710, 'anosha.saeed', 'retry')];
  assert.equal(stuckReleased(retry, stuck, APPROVERS, false), true);
  assert.equal(stuckReleased([note(690, 'anosha.saeed', 'retry')], stuck, APPROVERS, false), false);
  assert.equal(stuckReleased([note(710, 'usman.nasir', 'retry')], stuck, APPROVERS, false), false);
  assert.equal(stuckReleased([note(710, 'arsal.tariq', 'x <!-- oneshot:automation:failed:0123456789ab -->')], stuck, APPROVERS, false), false);
  assert.equal(stuckReleased(retry, { ...stuck, sinceNoteId: null }, APPROVERS, false), false);
  assert.equal(stuckReleased(retry, stuck, APPROVERS, true), false);
});

test('AUTOMATION_DENY takes away Bash, the web, and every file-reading tool', () => {
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Read', 'Grep', 'Glob', 'NotebookRead', 'LSP', 'AskUserQuestion']) {
    assert.ok(AUTOMATION_DENY.includes(t), t);
  }
  // The session starts without the GitLab MCP server; these writes stay denied
  // as the floor, should it ever be handed back.
  for (const t of ['create_label', 'delete_issue', 'create_pipeline', 'fork_repository', 'download_attachment']) {
    assert.ok(AUTOMATION_DENY.includes(`mcp__gitlab__${t}`), t);
  }
});

test('the single-run line says the state once', () => {
  assert.equal(outcomeLine({ iid: 101, state: 'done', did: 'done — sheet written, labels flipped, done note posted' }),
    'auto       #101 done — sheet written, labels flipped, done note posted');
  assert.equal(outcomeLine({ iid: 101, state: 'stuck', did: 'stuck — waiting for a QA approver to comment' }),
    'auto       #101 stuck — waiting for a QA approver to comment');
  assert.equal(outcomeLine({ iid: 101, state: 'not-ready', did: 'not ready (0123456789ab: rfd-order) — commented' }),
    'auto       #101 not ready (0123456789ab: rfd-order) — commented');
  // A `did` that does not open with the state gets it in front.
  assert.equal(outcomeLine({ iid: 101, state: 'done', did: 'finished earlier — archive its state/automation directory and remove its sheet block to redo' }),
    'auto       #101 done — finished earlier — archive its state/automation directory and remove its sheet block to redo');
  assert.equal(outcomeLine({ iid: 101, state: 'in-review', did: 'v1 waiting on QA' }), 'auto       #101 in-review — v1 waiting on QA');
  // A word that merely starts with the state's letters is not the state.
  assert.equal(outcomeLine({ iid: 101, state: 'new', did: 'newer notes arrived' }), 'auto       #101 new — newer notes arrived');
});
