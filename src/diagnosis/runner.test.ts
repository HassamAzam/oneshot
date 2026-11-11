import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { ROOT, type PhaseConfig } from '../lib/config.js';
import type { GitlabResult, Issue, IssueNote } from '../lib/gitlab.js';
import { CANCELLED_BY_CONDUCTOR, type PhaseInput, type PhaseOutput } from '../conductor/phase.js';
import { diagnosisMarker } from './note.js';
import { readDiagnosisFile, updateDiagnosisFile } from './record.js';
import {
  diagnoseRun, diagnosisTick, normaliseDiagnosis, outcomeLine, sessionCharged, type DiagnosisDeps,
} from './runner.js';
import type { DiagnosisConfig } from './stop.js';
import { init, lateExit, makeRun, rewriteJournal, success, type RunSpec } from './test-fixtures.js';

const CRASH = 'Claude Code process exited with code 1';
const NOW = Date.UTC(2026, 10, 10, 12, 0);

const PHASE: PhaseConfig = {
  name: 'diagnose', n: 15, kind: 'session', tier: 'heavy', cwd: 'conductor', maxTurns: 80, timeoutMin: 30,
  writes: [], onFail: 'warn', onDemand: true, artifact: 'diagnosis/session.json',
};

const CFG: DiagnosisConfig = {
  enabled: true, post: true, fix: false, maxPerRun: 4, maxAttempts: 2,
  minGapMs: 20 * 60_000, settleMs: 20_000, maxAgeMs: 7 * 86_400_000, retryGapMs: 10 * 60_000,
};

/** A blocked run whose one failed lap really finished: the shape the digest finds for itself. */
const BLOCKED: RunSpec = {
  iid: 990174, status: 'blocked', stoppedPhase: 'merge', blockedWhy: 'merge: refused over F-05',
  records: [{ phase: 'verify', status: 'failed', error: CRASH, turns: 160 }, { phase: 'merge', status: 'failed', error: 'refused over F-05' }],
  transcripts: { 'verify-lap0.jsonl': [init(), success(160), lateExit()] },
};

const ok = <T>(data: T): GitlabResult<T> => ({ ok: true, kind: 'ok', status: 200, data });
const down = <T>(): GitlabResult<T> => ({ ok: false, kind: 'network', status: 0, data: null, error: 'unreachable' });
const refused = <T>(): GitlabResult<T> => ({ ok: false, kind: 'auth', status: 403, data: null, error: 'forbidden' });
const issue = (assignees: string[] = []): Issue => ({
  iid: 990174, title: 't', description: null, labels: [], assignees: assignees.map((username) => ({ username })),
  state: 'opened', web_url: '', updated_at: '',
});

/** What the session would return: one finding cited in the journal, one cited nowhere. */
const ANSWER = {
  summary: 'the verify lap finished and was recorded as a crash',
  headline: 'The recorded crash hid a session that had finished.',
  account: 'verify lap 0 settled success (D-1).',
  findings: [
    {
      id: 'D-1', title: 'The CLI exit replaced the recorded outcome', category: 'harness', phases: 'verify lap 0',
      recorded: CRASH, cause: 'the exit text overwrote the result',
      evidence: [{ file: 'run.json', line: 1, quote: `"error": "${CRASH}"` }],
      solution: 'keep the settled result', where: ['src/conductor/phase.ts'], fix: 'pr', confidence: 'confirmed',
    },
    {
      id: 'D-2', title: 'A guess about the port pool', category: 'environment', phases: '', recorded: '', cause: 'maybe',
      evidence: [{ file: 'run.json', line: 1, quote: 'the port pool was drained completely' }],
      solution: '', where: [], fix: 'operator', confidence: 'probable',
    },
  ],
  decisive: 'D-1', nextStep: 'Deploy the fix and resume.', resumeFrom: 'implement',
};

const out = (over: Partial<PhaseOutput> = {}): PhaseOutput => ({
  ok: true, data: ANSWER as unknown as Record<string, unknown>, blocked: null, summary: '', turns: 34, weighted: 500_000,
  sessionId: 's', rateLimited: false, ...over,
});

interface World {
  deps: Partial<DiagnosisDeps>;
  sessions: PhaseInput[];
  posted: Array<{ iid: number; body: string }>;
  events: string[];
  attempts: string[];
  dirs: Record<number, string>;
  set(over: Partial<{ cfg: DiagnosisConfig; now: number; answer: (i: PhaseInput) => PhaseOutput | Promise<PhaseOutput>; issue: GitlabResult<Issue>; notes: GitlabResult<IssueNote[]>; add: () => GitlabResult<{ id: number }>; dryRun: boolean; hold: string | null | ((runId: string) => string | null); ours: boolean; me: string; reachable: boolean; paused: boolean; log: () => Promise<{ unavailable: string }>; rows: (runId: string) => undefined }>): void;
  gitlabCalls: number;
  /** Times the project check ran: it shells out to git, so it must not run on a look that does nothing. */
  oursCalls: number;
  cleanup(): void;
}

function world(...specs: RunSpec[]): World {
  const runs = (specs.length ? specs : [BLOCKED]).map((s) => ({ spec: s, ...makeRun(s) }));
  const dirs = Object.fromEntries(runs.map((r) => [r.spec.iid ?? 990174, r.dir]));
  const s = {
    cfg: CFG, now: NOW, answer: (() => out()) as (i: PhaseInput) => PhaseOutput | Promise<PhaseOutput>,
    issue: ok(issue()), notes: ok<IssueNote[]>([]), add: () => ok({ id: 501 }), dryRun: false,
    hold: null as string | null | ((runId: string) => string | null), ours: true, me: 'oneshot-bot',
    reachable: true, paused: false,
    log: (async () => ({ unavailable: 'not in a test' })) as () => Promise<{ unavailable: string }>,
    rows: (() => undefined) as (runId: string) => undefined,
  };
  const w: World = {
    sessions: [], posted: [], events: [], attempts: [], dirs, gitlabCalls: 0, oursCalls: 0,
    set: (over) => { Object.assign(s, over); },
    cleanup: () => { for (const r of runs) r.cleanup(); },
    deps: {
      cfg: () => s.cfg,
      get dryRun() { return s.dryRun; },
      now: () => s.now,
      me: () => s.me,
      stopped: () => runs.map((r) => ({ iid: r.spec.iid ?? 990174, runId: r.spec.runId ?? 'r-test0001-abcdef', status: r.spec.status ?? 'blocked' })),
      runDir: (iid) => dirs[iid] ?? '/nonexistent',
      repo: ROOT,
      phase: () => PHASE,
      policy: () => ({ 'mr-open': { kind: 'code', onFail: 'warn' } }),
      ours: () => { w.oursCalls += 1; return s.ours; },
      dbRows: (runId) => s.rows(runId),
      conductorLog: () => s.log(),
      session: async (input) => { w.sessions.push(input); return s.answer(input); },
      sessionHold: (runId) => (typeof s.hold === 'function' ? s.hold(runId) : s.hold),
      paused: () => s.paused,
      attempt: { start: (_r, lap) => { w.attempts.push(`start:${lap}`); return 1; }, end: (_id, status) => { w.attempts.push(`end:${status}`); } },
      gitlab: {
        getIssue: async () => { w.gitlabCalls += 1; return s.issue; },
        notes: async () => { w.gitlabCalls += 1; return s.notes; },
        addNote: async (iid, body) => { w.gitlabCalls += 1; const r = s.add(); if (r.ok) w.posted.push({ iid, body }); return r; },
      },
      reachable: () => s.reachable,
      repoHead: async () => 'main @ abc1234',
      dashboardUrl: () => undefined,
      event: (kind) => { w.events.push(kind); },
    },
  };
  return w;
}

const run = (w: World, iid = 990174, opts: Parameters<typeof diagnoseRun>[1] = {}) => diagnoseRun(iid, opts, w.deps);
const record = (w: World, iid = 990174) => {
  const f = readDiagnosisFile(w.dirs[iid]!);
  assert.ok(f, 'diagnosis.json was written');
  return { file: f, stop: f.stops[f.latest ?? Object.keys(f.stops)[0]!]! };
};

test('a blocked run is diagnosed once: the digest is written, the session is read-only and tool-less, the note is posted', async () => {
  const w = world();
  try {
    const o = await run(w);
    assert.deepEqual({ act: o.act, findings: 'findings' in o ? o.findings : -1, posted: 'posted' in o ? o.posted : false }, { act: 'diagnosed', findings: 2, posted: true });

    assert.equal(w.sessions.length, 1);
    const s = w.sessions[0]!;
    assert.equal(s.cfg.name, 'diagnose');
    assert.equal(s.gitlabMcp, false, 'the session starts without the GitLab server');
    assert.equal(s.lap, 0);
    assert.match(s.prompt, /\[finished-then-exit\] verify lap 0 was recorded failed/, 'the digest is in the prompt');
    assert.ok(s.prompt.includes(`peek --dir ${w.dirs[990174]}`));
    assert.ok(existsSync(join(w.dirs[990174]!, 'diagnosis', 'evidence.json')), 'the full digest is beside the run for the session to cite');

    const { file, stop } = record(w);
    assert.equal(stop.state, 'diagnosed');
    assert.equal(file.sessions, 1);
    assert.equal(stop.headline, ANSWER.headline);
    assert.deepEqual(stop.findings!.map((f) => f.evidenced), [true, false], 'citations were re-opened: one held, one did not');
    assert.deepEqual(stop.citations, { checked: 2, verified: 1 });
    assert.deepEqual(stop.read, { transcripts: 1, transcriptBytes: stop.read!.transcriptBytes });
    assert.equal(stop.note?.id, 501);

    assert.equal(w.posted.length, 1);
    assert.match(w.posted[0]!.body, /\*\*Oneshot diagnosis\*\* — The recorded crash hid a session that had finished\./);
    assert.match(w.posted[0]!.body, /Leads, not findings/);
    assert.ok(w.posted[0]!.body.includes(diagnosisMarker(stop.key)));
    assert.deepEqual(w.attempts, ['start:0', 'end:ok'], 'the session has a phase_runs row, so its time and tokens show');
    assert.deepEqual(w.events, ['diagnosis_started', 'diagnosis_done', 'diagnosis_posted']);
  } finally { w.cleanup(); }
});

test('the same stop, looked at again a minute later, costs nothing: no session and no second note', async () => {
  const w = world();
  try {
    await run(w);
    w.set({ now: NOW + 60_000 });
    const again = await run(w);
    assert.equal(again.act, 'skipped');
    assert.match(outcomeLine(again), /this stop already has its diagnosis/);
    assert.equal(w.sessions.length, 1);
    assert.equal(w.posted.length, 1);
  } finally { w.cleanup(); }
});

test('a run parked at a gate with nothing wrong on its record is never given a session', async () => {
  const w = world({ iid: 990174, status: 'parked', blockedWhy: 'awaiting plan approval', records: [{ phase: 'recall' }, { phase: 'research' }, { phase: 'plan' }] });
  try {
    const o = await run(w);
    assert.equal(o.act, 'skipped');
    assert.match(outcomeLine(o), /routine wait/);
    assert.equal(w.sessions.length, 0);
    assert.equal(existsSync(join(w.dirs[990174]!, 'diagnosis.json')), false, 'nothing is written for a stop that needs nothing');
  } finally { w.cleanup(); }
});

test('a run parked with failures behind it is diagnosed, and re-parking it with one more record does not diagnose it again', async () => {
  const spec: RunSpec = { ...BLOCKED, status: 'parked', blockedWhy: 'awaiting QA on failing verify cases', stoppedPhase: 'verify' };
  const w = world(spec);
  try {
    assert.equal((await run(w)).act, 'diagnosed');
    // The next tick: the runner re-entered, added a record, and parked again.
    rewriteJournal(w.dirs[990174]!, { ...spec, records: [...spec.records!, { phase: 'verify', lap: 1, status: 'failed', error: CRASH }], stoppedAt: NOW + 50_000 });
    w.set({ now: NOW + 60 * 60_000 });
    assert.equal((await run(w)).act, 'skipped');
    assert.equal(w.sessions.length, 1);
  } finally { w.cleanup(); }
});

test('a ticket handed to a teammate since the run stopped is diagnosed and not written to', async () => {
  const w = world();
  try {
    w.set({ issue: ok(issue(['a.teammate'])) });
    const o = await run(w);
    assert.equal(o.act, 'diagnosed');
    assert.equal('posted' in o && o.posted, false);
    assert.equal(w.posted.length, 0);
    assert.match(record(w).stop.noteSkipped ?? '', /assigned to a\.teammate, not to oneshot-bot/);
  } finally { w.cleanup(); }
});

test('a note already on the ticket for this stop is adopted, not posted twice', async () => {
  // A process killed between the POST and the write finds its own note by the marker.
  const w = world();
  try {
    w.set({ answer: () => out(), notes: ok<IssueNote[]>([]) });
    await run(w);
    const { stop } = record(w);
    const w2 = world();
    try {
      w2.set({ notes: ok<IssueNote[]>([{ id: 77, body: `earlier\n${diagnosisMarker(stop.key)}` }]) });
      const o = await run(w2);
      assert.equal('posted' in o && o.posted, true);
      assert.equal(w2.posted.length, 0, 'nothing new was posted');
      assert.equal(record(w2).stop.note?.id, 77);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test('a note GitLab refused is retried on later looks without another session, and given up on after five', async () => {
  const w = world();
  try {
    w.set({ add: () => refused<{ id: number }>() });
    const first = await run(w);
    assert.equal('posted' in first && first.posted, false);
    assert.equal(record(w).stop.noteTries, 1);

    w.set({ add: () => ok({ id: 9 }), now: NOW + 60_000 });
    const second = await run(w);
    assert.equal(second.act, 'diagnosed');
    assert.equal(w.posted.length, 1);
    assert.equal(record(w).stop.noteTries, undefined);
    assert.equal(w.sessions.length, 1, 'the diagnosis was not paid for twice');

    const w2 = world();
    try {
      w2.set({ issue: refused<Issue>() });
      for (let i = 0; i < 6; i += 1) { w2.set({ now: NOW + i * 60_000 }); await run(w2); }
      assert.match(record(w2).stop.noteSkipped ?? '', /could not read the ticket \(auth\), 5 times/);
      assert.equal(w2.sessions.length, 1);
    } finally { w2.cleanup(); }
  } finally { w.cleanup(); }
});

test('an outage does not use up the tries: the note is still owed when GitLab comes back', async () => {
  const w = world();
  try {
    w.set({ issue: down<Issue>() });
    for (let i = 0; i < 8; i += 1) { w.set({ now: NOW + i * 60_000 }); await run(w); }
    assert.equal(record(w).stop.noteTries, undefined);
    assert.equal(record(w).stop.noteSkipped, undefined);

    // The breaker is open: nothing calls GitLab at all.
    const calls = w.gitlabCalls;
    w.set({ reachable: false, now: NOW + 9 * 60_000 });
    await run(w);
    assert.equal(w.gitlabCalls, calls);

    w.set({ reachable: true, issue: ok(issue()), now: NOW + 10 * 60_000 });
    const back = await run(w);
    assert.equal('posted' in back && back.posted, true);
    assert.equal(w.posted.length, 1);
    assert.equal(w.sessions.length, 1);
  } finally { w.cleanup(); }
});

test('a closed ticket is diagnosed and not commented on', async () => {
  const w = world();
  try {
    w.set({ issue: ok({ ...issue(), state: 'closed' }) });
    await run(w);
    assert.equal(w.posted.length, 0);
    assert.match(record(w).stop.noteSkipped ?? '', /the ticket is closed/);
  } finally { w.cleanup(); }
});

test('diagnosed without posting, then asked to post: the note goes up and no second session runs', async () => {
  // `npm run diagnose -- 9174`, read it, then `npm run diagnose -- 9174 --post`.
  const w = world();
  try {
    await run(w, 990174, { force: true, post: false });
    assert.equal(w.posted.length, 0);
    assert.match(record(w).stop.noteSkipped ?? '', /posting is off/);

    const o = await run(w, 990174, { force: true, post: true });
    assert.deepEqual({ act: o.act, posted: 'posted' in o && o.posted }, { act: 'diagnosed', posted: true });
    assert.equal(w.posted.length, 1);
    assert.equal(w.sessions.length, 1);
    assert.equal(record(w).stop.noteSkipped, undefined);
  } finally { w.cleanup(); }
});

test('looking at a stop by hand without --post does not cancel a note the conductor still owes', async () => {
  const w = world();
  try {
    w.set({ issue: down<Issue>() });
    await run(w);
    w.set({ issue: ok(issue()), now: NOW + 60_000 });
    await run(w, 990174, { force: true, post: false });
    assert.equal(record(w).stop.noteSkipped, undefined, 'still owed');
    w.set({ now: NOW + 120_000 });
    await run(w);
    assert.equal(w.posted.length, 1);
  } finally { w.cleanup(); }
});

test('two processes looking at one stop: the second finds the lock and pays for nothing', async () => {
  // A desk can run several conductors over one state directory.
  const w = world();
  try {
    const dir = w.dirs[990174]!;
    let inner: Awaited<ReturnType<typeof run>> | null = null;
    w.set({ answer: async () => { inner = await diagnoseRun(990174, {}, w.deps); return out(); } });
    const o = await run(w);
    assert.equal(o.act, 'diagnosed');
    assert.deepEqual(inner, { iid: 990174, act: 'skipped', why: 'a session for this stop is running, or failed minutes ago; retrying later' }, 'the attempt on record already holds the second off');
    assert.equal(w.sessions.length, 1);

    // And when the record has not been written yet, the lock file itself does.
    const w2 = world();
    try {
      const d2 = w2.dirs[990174]!;
      const key = (await (async () => { await run(w2); return record(w2).stop.key; })());
      rmSync(join(d2, 'diagnosis.json'));
      mkdirSync(join(d2, 'diagnosis'), { recursive: true });
      writeFileSync(join(d2, 'diagnosis', `.lock-${key}`), 'held');
      w2.set({ now: NOW + 3_600_000 });
      assert.deepEqual(await run(w2), { iid: 990174, act: 'skipped', why: 'another process is diagnosing this stop' });
      assert.equal(w2.sessions.length, 1);

      // A lock left by a process that died is taken over.
      const old = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(join(d2, 'diagnosis', `.lock-${key}`), old, old);
      assert.equal((await run(w2)).act, 'diagnosed');
      assert.equal(existsSync(join(d2, 'diagnosis', `.lock-${key}`)), false, 'and released afterwards');
    } finally { w2.cleanup(); }
    assert.equal(existsSync(join(dir, 'diagnosis', `.lock-${record(w).stop.key}`)), false);
  } finally { w.cleanup(); }
});

test('what another writer put in the record during the session is still there afterwards', async () => {
  // The fix pipeline, or a diagnosis by hand, writes the same file while a session runs.
  const w = world();
  try {
    const dir = w.dirs[990174]!;
    w.set({ answer: () => {
      updateDiagnosisFile(dir, { iid: 990174, runId: 'r-test0001-abcdef' }, (f) => {
        f.stops.other = { key: 'other', runId: 'r-test0001-abcdef', iid: 990174, status: 'parked', stoppedPhase: 'verify', reason: '', trouble: [], state: 'diagnosed', attempts: 1, lastAttemptAt: 1, fixes: { 'D-1': { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1 } } };
      });
      return out();
    } });
    await run(w);
    const f = readDiagnosisFile(dir)!;
    assert.equal(f.stops.other?.fixes?.['D-1']?.state, 'opened');
    assert.equal(Object.keys(f.stops).length, 2);
  } finally { w.cleanup(); }
});

test('a run that stopped somewhere else while it was being diagnosed keeps the diagnosis and gets no note', async () => {
  const w = world();
  try {
    // Unblocked during the session, and blocked again for another reason.
    w.set({ answer: () => { rewriteJournal(w.dirs[990174]!, { ...BLOCKED, blockedWhy: 'verify: the app would not start' }); return out(); } });
    const o = await run(w);
    assert.equal(o.act, 'superseded');
    assert.equal(w.posted.length, 0);
    const { stop } = record(w);
    assert.equal(stop.state, 'superseded');
    assert.equal(stop.headline, ANSWER.headline, 'the work is kept for the dashboard');
    assert.match(stop.noteSkipped ?? '', /moved on while it was being diagnosed \(now blocked\)/);
  } finally { w.cleanup(); }
});

test('a run that reads running when the session ends keeps its diagnosis, and the note is posted once it is back at the stop', async () => {
  const w = world();
  try {
    // A parked run is re-claimed on every tick and reads `running`, with no
    // reason, until it is parked again. A session that ended in those seconds
    // used to be filed as superseded: never posted, and never diagnosed again.
    w.set({ answer: () => { rewriteJournal(w.dirs[990174]!, { ...BLOCKED, status: 'running', blockedWhy: undefined }); return out(); } });
    const o = await run(w);
    assert.deepEqual({ act: o.act, posted: 'posted' in o && o.posted }, { act: 'diagnosed', posted: false });
    assert.equal(w.posted.length, 0, 'nothing is written on a ticket whose run is running');
    assert.deepEqual({ state: record(w).stop.state, skipped: record(w).stop.noteSkipped }, { state: 'diagnosed', skipped: undefined });

    // Still running: nothing happens, and no second session.
    assert.equal((await run(w)).act, 'skipped');
    assert.equal(w.posted.length, 0);

    // Back at the same stop: the note that was owed is posted, without another session.
    rewriteJournal(w.dirs[990174]!, BLOCKED);
    const again = await run(w);
    assert.deepEqual({ act: again.act, posted: 'posted' in again && again.posted }, { act: 'diagnosed', posted: true });
    assert.equal(w.posted.length, 1);
    assert.equal(w.sessions.length, 1);
  } finally { w.cleanup(); }
});

test('a session that fails is one attempt; the stop is retried after a wait and given up on after two', async () => {
  const w = world();
  try {
    w.set({ answer: () => out({ ok: false, data: null, error: 'error_max_turns: ', turns: 80 }) });
    const first = await run(w);
    assert.deepEqual({ act: first.act }, { act: 'failed' });
    assert.deepEqual({ state: record(w).stop.state, attempts: record(w).stop.attempts }, { state: 'failed', attempts: 1 });
    assert.deepEqual(w.attempts, ['start:0', 'end:failed']);

    w.set({ now: NOW + 60_000 });
    assert.match(outcomeLine(await run(w)), /retrying later/);
    w.set({ now: NOW + 11 * 60_000 });
    assert.equal((await run(w)).act, 'failed');
    assert.equal(w.sessions[1]!.lap, 1, 'the second session writes its own transcript');
    w.set({ now: NOW + 60 * 60_000 });
    assert.match(outcomeLine(await run(w)), /gave up on this stop after 2 sessions/);
    assert.equal(w.sessions.length, 2);
    assert.equal(w.posted.length, 0);
  } finally { w.cleanup(); }
});

test('a cancelled or rate-limited session is not counted against the stop', async () => {
  const w = world();
  try {
    w.set({ answer: () => out({ ok: false, data: null, error: CANCELLED_BY_CONDUCTOR, infra: true, turns: 0, weighted: 0 }) });
    const o = await run(w);
    assert.equal(o.act, 'held');
    assert.equal(record(w).stop.attempts, 0);
    assert.deepEqual(w.attempts, ['start:0', 'end:infra']);
  } finally { w.cleanup(); }
});

test('a session that throws is a failed attempt, not a crashed conductor', async () => {
  const w = world();
  try {
    w.set({ answer: () => { throw new Error('spawn node ENOENT'); } });
    const o = await run(w);
    assert.equal(o.act, 'failed');
    assert.match(record(w).stop.lastError ?? '', /spawn node ENOENT/);
  } finally { w.cleanup(); }
});

test('nothing is started while the desk is held, and nothing is recorded for the wait', async () => {
  const w = world();
  try {
    w.set({ hold: 'parked after a subscription usage limit' });
    const o = await run(w);
    assert.deepEqual(o, { iid: 990174, act: 'held', why: 'parked after a subscription usage limit' });
    assert.equal(w.sessions.length, 0);
    assert.equal(existsSync(join(w.dirs[990174]!, 'diagnosis.json')), false);
  } finally { w.cleanup(); }
});

test('a journal from another project, or no journal at all, is left alone', async () => {
  const w = world();
  try {
    w.set({ ours: false });
    assert.match(outcomeLine(await run(w)), /belongs to another project/);
    assert.match(outcomeLine(await run(w, 123)), /no run journal on this desk/);
    assert.equal(w.sessions.length, 0);
  } finally { w.cleanup(); }
});

test('with posting off, or in a dry run, the diagnosis is made and the ticket is not touched; --post overrides the setting', async () => {
  for (const over of [{ cfg: { ...CFG, post: false } }, { dryRun: true }]) {
    const w = world();
    try {
      w.set(over);
      const o = await run(w);
      assert.equal(o.act, 'diagnosed');
      assert.equal(w.posted.length, 0);
      assert.ok(record(w).stop.noteSkipped);
    } finally { w.cleanup(); }
  }
  const w = world();
  try {
    w.set({ cfg: { ...CFG, post: false } });
    await run(w, 990174, { post: true });
    assert.equal(w.posted.length, 1);
  } finally { w.cleanup(); }
});

test('the fix step runs only on a desk that asked for it', async () => {
  for (const [fix, expected] of [[false, 0], [true, 1]] as const) {
    const w = world();
    try {
      let called = 0;
      w.set({ cfg: { ...CFG, fix } });
      await diagnoseRun(990174, {}, { ...w.deps, fix: async () => { called += 1; } });
      assert.equal(called, expected);
    } finally { w.cleanup(); }
  }
});

test('one pass diagnoses one run: the next stop waits for the next pass', async () => {
  const w = world({ ...BLOCKED, iid: 990001, runId: 'r-a' }, { ...BLOCKED, iid: 990002, runId: 'r-b' });
  try {
    const first = await diagnosisTick({}, w.deps);
    assert.deepEqual(first.map((o) => `${o.iid}:${o.act}`), ['990001:diagnosed']);
    w.set({ now: NOW + 60_000 });
    const second = await diagnosisTick({}, w.deps);
    assert.deepEqual(second.map((o) => `${o.iid}:${o.act}`), ['990001:skipped', '990002:diagnosed']);
    assert.equal(w.sessions.length, 2);
  } finally { w.cleanup(); }
});

test('the mode does nothing at all on a desk that has not turned it on', async () => {
  const w = world();
  try {
    w.set({ cfg: { ...CFG, enabled: false } });
    assert.deepEqual(await diagnosisTick({}, w.deps), []);
    assert.equal(w.sessions.length, 0);
  } finally { w.cleanup(); }
});

test('a diagnosis never writes the run journal', async () => {
  // The runner holds the journal in memory and writes it back; a second writer
  // would lose one side's change. Everything this mode records is its own file.
  const w = world();
  try {
    const before = readFileSync(join(w.dirs[990174]!, 'run.json'), 'utf8');
    await run(w);
    assert.equal(readFileSync(join(w.dirs[990174]!, 'run.json'), 'utf8'), before);
  } finally { w.cleanup(); }
});

test('normaliseDiagnosis gives every field its shape, whatever the session sent', () => {
  const d = normaliseDiagnosis({ findings: [{ category: 'cosmic rays', fix: 'prayer', evidence: 'none', where: 'everywhere' }, null], headline: 7 });
  assert.equal(d.headline, '');
  assert.equal(d.findings.length, 2);
  assert.deepEqual(
    { id: d.findings[0]!.id, category: d.findings[0]!.category, fix: d.findings[0]!.fix, confidence: d.findings[0]!.confidence, evidence: d.findings[0]!.evidence, where: d.findings[0]!.where },
    { id: 'D-1', category: 'environment', fix: 'person', confidence: 'probable', evidence: [], where: [] },
  );
  assert.equal(d.findings[1]!.id, 'D-2');
  const sha = (fixedBy: unknown): string | undefined => normaliseDiagnosis({ findings: [{ fixedBy }] }).findings[0]!.fixedBy;
  assert.equal(sha('f915c43'), 'f915c43');
  assert.equal(sha('  1c4a941e8f07ad  '), '1c4a941e8f07ad');
  assert.equal(sha('see the commit on main'), '', 'only something shaped like a commit id is kept');
  assert.equal(sha(undefined), '');
});

test('sessionCharged: only a session that reached the model and was not withdrawn is counted', () => {
  assert.equal(sessionCharged(out({ ok: false, error: 'error_max_turns' })), true);
  assert.equal(sessionCharged(out({ ok: false, error: CANCELLED_BY_CONDUCTOR })), false);
  assert.equal(sessionCharged(out({ ok: false, rateLimited: true })), false);
  assert.equal(sessionCharged(out({ ok: false, accountAction: 'terms' })), false);
  assert.equal(sessionCharged(out({ ok: false, infra: true, turns: 0, weighted: 0 })), false);
  assert.equal(sessionCharged(out({ ok: false, infra: true, turns: 12, weighted: 9000 })), true);
});

// ------------------------------------------------- what a review of this found

test('the session is told its own words are not a usage-limit notice', async () => {
  // phase.ts reads every session's prose for "resets 4:30pm" and parks the whole
  // conductor when it finds it. Writing about a run that hit the limit is this
  // session's job.
  const w = world();
  try {
    await run(w);
    assert.equal(w.sessions[0]!.limitFromProse, false);
    assert.equal(w.sessions[0]!.gitlabMcp, false);
  } finally { w.cleanup(); }
});

test('a run that stopped on the usage limit is left alone by the tick, and diagnosed when a person asks', async () => {
  const w = world({ ...BLOCKED, blockedWhy: 'subscription usage limit — parked until the window resets' });
  try {
    const o = await diagnosisTick({}, w.deps);
    assert.match(outcomeLine(o[0]!), /usage or budget limit, which explains itself/);
    assert.equal(w.sessions.length, 0);
    assert.equal((await run(w, 990174, { force: true })).act, 'diagnosed');
  } finally { w.cleanup(); }
});

test('sessions cut off through no fault of the stop are free twice, and then counted, so a false alarm cannot repeat for a week', async () => {
  const w = world();
  try {
    w.set({ answer: () => out({ ok: false, data: null, rateLimited: true, error: 'rate_limit: resets 4:30pm', turns: 3, weighted: 9000 }) });
    const acts: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      w.set({ now: NOW + i * 11 * 60_000 });
      acts.push((await run(w)).act);
    }
    // Two free, two counted, then given up on.
    assert.deepEqual(acts, ['held', 'held', 'failed', 'failed', 'skipped', 'skipped']);
    assert.equal(w.sessions.length, 4);
    assert.deepEqual({ attempts: record(w).stop.attempts, free: record(w).stop.free }, { attempts: 2, free: 2 });
  } finally { w.cleanup(); }
});

test('a look that does nothing never asks whose project the journal is: that question runs git', async () => {
  const w = world();
  try {
    await run(w);
    assert.equal(w.oursCalls, 1, 'asked once, when a session was about to start');
    for (let i = 1; i <= 5; i += 1) {
      w.set({ now: NOW + i * 60_000 });
      assert.equal((await run(w)).act, 'skipped');
    }
    assert.equal(w.oursCalls, 1);

    const routine = world({ iid: 990200, status: 'parked', blockedWhy: 'awaiting plan approval', records: [{ phase: 'plan' }] });
    try {
      await run(routine, 990200);
      assert.equal(routine.oursCalls, 0);
    } finally { routine.cleanup(); }
  } finally { w.cleanup(); }
});

test('the digest is built from the journal the decision was made from, not from a second read', async () => {
  const w = world();
  try {
    // The conductor log is the slow await. Meanwhile the runner re-claims the run for its tick.
    w.set({ log: async () => { rewriteJournal(w.dirs[990174]!, { ...BLOCKED, status: 'running', blockedWhy: undefined }); return { unavailable: 'x' }; } });
    await run(w);
    const digest = JSON.parse(readFileSync(join(w.dirs[990174]!, 'diagnosis', 'evidence.json'), 'utf8')) as { run: { status: string; reason: string } };
    assert.deepEqual(digest.run, { ...digest.run, status: 'blocked', reason: 'merge: refused over F-05' });
    assert.match(w.sessions[0]!.prompt, /This run has stopped, blocked, at `merge`/);
  } finally { w.cleanup(); }
});

test('a ticket another run has since claimed is not commented on', async () => {
  const w = world();
  try {
    const claim = { id: 7, system: false, created_at: new Date(NOW - 60_000).toISOString(), body: 'Oneshot claimed this ticket — run `r-other000-111111` (another desk).' };
    w.set({ notes: ok([claim] as unknown as IssueNote[]) });
    const o = await run(w);
    assert.deepEqual({ act: o.act, posted: 'posted' in o && o.posted }, { act: 'diagnosed', posted: false });
    assert.equal(w.posted.length, 0);
    assert.match(record(w).stop.noteSkipped ?? '', /run r-other000-111111 has since claimed the ticket/);
  } finally { w.cleanup(); }
});

test('the run\'s own claim does not hold its note back', async () => {
  const w = world({ ...BLOCKED, status: 'parked', blockedWhy: 'verify: awaiting a decision on TC-21' });
  try {
    const mine = { id: 7, system: false, created_at: new Date(NOW - 60_000).toISOString(), body: 'Oneshot claimed this ticket — run `r-test0001-abcdef` (this desk).' };
    w.set({ notes: ok([mine] as unknown as IssueNote[]) });
    assert.equal(w.posted.length, 0);
    await run(w);
    assert.equal(w.posted.length, 1);
  } finally { w.cleanup(); }
});

test('a paused desk writes nothing: the note is owed, and posted when the pause is lifted', async () => {
  const w = world();
  try {
    w.set({ answer: () => { w.set({ paused: true }); return out(); } });
    const o = await run(w);
    assert.deepEqual({ act: o.act, posted: 'posted' in o && o.posted }, { act: 'diagnosed', posted: false });
    assert.equal(w.gitlabCalls, 0, 'not even a read');
    assert.equal(record(w).stop.noteSkipped, undefined);
    w.set({ paused: false, now: NOW + 60_000 });
    await run(w);
    assert.equal(w.posted.length, 1);
    assert.equal(w.sessions.length, 1);
  } finally { w.cleanup(); }
});

test('one run that throws does not hide the stops behind it', async () => {
  const w = world({ ...BLOCKED, iid: 990001, runId: 'r-a' }, { ...BLOCKED, iid: 990002, runId: 'r-b' });
  try {
    w.set({ rows: (runId) => { if (runId === 'r-a') throw new Error('database disk image is malformed'); return undefined; } });
    const o = await diagnosisTick({}, w.deps);
    assert.deepEqual(o.map((x) => `${x.iid}:${x.act}`), ['990001:failed', '990002:diagnosed']);
    assert.match(outcomeLine(o[0]!), /the diagnosis threw: database disk image is malformed/);
  } finally { w.cleanup(); }
});

test('a run held by its own budget does not hold up the next one', async () => {
  const w = world({ ...BLOCKED, iid: 990001, runId: 'r-a' }, { ...BLOCKED, iid: 990002, runId: 'r-b' });
  try {
    w.set({ hold: (runId) => (runId === 'r-a' ? 'per-ticket ceiling reached' : null) });
    const o = await diagnosisTick({}, w.deps);
    assert.deepEqual(o.map((x) => `${x.iid}:${x.act}`), ['990001:held', '990002:diagnosed']);
  } finally { w.cleanup(); }
});

test('a finding\'s id is held to its shape: it goes into a hidden marker, a branch name and a file name', () => {
  const d = normaliseDiagnosis({
    decisive: 'D-1 -->\n/close',
    findings: [{ id: 'D-1 -->\n/close\n@all\n<!-- x' }, { id: 'D-2' }, { id: 'D-2' }, { id: '../../etc' }, { id: 'D-7' }],
  });
  assert.deepEqual(d.findings.map((f) => f.id), ['D-1', 'D-2', 'D-3', 'D-4', 'D-7']);
  assert.equal(d.decisive, '', 'a decisive id that names no finding is dropped');
  assert.equal(normaliseDiagnosis({ decisive: 'D-2', findings: [{ id: 'D-2' }] }).decisive, 'D-2');
});

// ----------------------------------------- what the adversarial pass found next

test('a record planted in the run directory cannot make the conductor post a command', async () => {
  // A session of the run, talked into it: a "diagnosed" stop under the journal's own key,
  // so no session is paid for and the note is rendered straight from the file.
  const w = world();
  try {
    await run(w);                                   // a real diagnosis, to learn the stop's key
    const key = record(w).stop.key;
    const planted = (stopKey: string) => writeFileSync(join(w.dirs[990174]!, 'diagnosis.json'), JSON.stringify({
      version: 1, iid: 990174, runId: 'r-test0001-abcdef', latest: key, sessions: 1,
      stops: { [key]: {
        key: stopKey, runId: 'r-test0001-abcdef', iid: 990174, status: 'blocked', stoppedPhase: 'merge\n/close', reason: '', trouble: [], state: 'diagnosed',
        attempts: 1, lastAttemptAt: 1, headline: 'looks fine\n/label ~"Ready For Deployment"', nextStep: '/unassign', resumeFrom: '/close',
        citations: { checked: 3, verified: '3\n/unassign\n' }, read: { transcripts: '2\n/close\n', transcriptBytes: 1 }, findings: [],
      } },
    }));

    // Claiming to be another key that closes the comment: not a stop at all, so nothing is posted from it.
    w.posted.length = 0;
    planted(`${key} -->\n/close\n/label ~"Ready For Deployment"\n<!-- x`);
    w.set({ now: NOW + 30 * 60_000 });
    const first = await run(w);
    assert.equal(first.act, 'diagnosed', 'the stop is simply diagnosed for real');
    assert.equal(w.sessions.length, 2);
    for (const p of w.posted) assert.doesNotMatch(p.body, /^\s*\/(close|label|unassign)/m);

    // Under its real key, with commands in every field: posted, and inert.
    w.posted.length = 0;
    planted(key);
    await run(w);
    assert.equal(w.posted.length, 1);
    const body = w.posted[0]!.body;
    assert.doesNotMatch(body, /^\s*\/(close|label|unassign)/m, body);
    assert.equal(body.match(/<!--/g)?.length, 1);
    assert.ok(body.trimEnd().endsWith(diagnosisMarker(key)));
    assert.match(body, /0 of 3 citations were re-opened and found/, 'a count that was not a number is not printed');
  } finally { w.cleanup(); }
});

test('two conductors that both see a note owed post it once', async () => {
  const w = world();
  try {
    // GitLab is unreachable when the diagnosis is made: the note is owed.
    w.set({ reachable: false });
    await run(w);
    w.set({ reachable: true, now: NOW + 60_000 });
    // The second look starts while the first is inside GitLab.
    let second: Promise<unknown> | null = null;
    const notes = w.deps.gitlab!.notes!;
    w.deps.gitlab!.notes = async (iid) => { second ??= run(w); return notes(iid); };
    await run(w);
    await second;
    assert.equal(w.posted.length, 1);
  } finally { w.cleanup(); }
});
