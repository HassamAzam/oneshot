/**
 * Sink against a real Postgres carrying the board schema. Destructive: it truncates
 * the tables it writes and drops/re-adds a column, so point TEST_DATABASE_URL at a
 * scratch database, never the board's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'TEST_DATABASE_URL unset — sink tests need a scratch Postgres with the board schema';

let pg, Sink, admin;
before(async () => {
  if (skip) return;
  pg = (await import('pg')).default;
  ({ Sink } = await import('./sink.mjs'));
  admin = new pg.Pool({ connectionString: URL_, max: 1 });
  await admin.query('alter table tool_calls add column if not exists input_summary text');
  await admin.query('alter table if exists evidence_x rename to evidence');
  await admin.query('truncate operators, runs, interventions, sessions, agent_calls, skill_calls, tool_calls, transcript_lines, evidence cascade');
});
after(async () => {
  if (skip) return;
  await admin.query('alter table sessions add column if not exists seq bigint not null default 0');
  await admin.query('alter table if exists evidence_x rename to evidence');
  await admin.query('alter table tool_calls add column if not exists input_summary text');
  await admin.end();
});

const op = { id: 'op-test', github_login: null, user_email: null, git_email: null, hostname: 'h', os_user: 'u', last_seen: new Date().toISOString() };
const run = (n) => ({ run_id: `run-${n}`, ticket_iid: n, title: `t${n}`, status: 'running', operator_id: op.id, archived: false });
const session = (n) => ({ session_id: `s-${n}`, run_id: `run-${n}`, ticket_iid: n, phase: 'plan', lap: 0, status: 'ok', turns: 0,
  tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, transcript_lines: 0, seq: 1, operator_id: op.id });

test('sink writes a batch and is idempotent', { skip }, async () => {
  const payload = { operators: [op], runs: [run(1), run(2)], sessions: [session(1), session(2)] };
  const sink = new Sink(URL_);
  await sink.open();
  try {
    const a = await sink.write(payload);
    const b = await sink.write(payload);
    assert.deepEqual(a, b);
    assert.equal(a.counts.runs, 2);
    assert.deepEqual(a.skipped, []);
    const { rows } = await admin.query('select count(*)::int as n from runs');
    assert.equal(rows[0].n, 2);
  } finally { await sink.close(); }
});

test('sink drops unknown columns', { skip }, async () => {
  await admin.query('alter table tool_calls drop column input_summary');
  const sink = new Sink(URL_);
  await sink.open();
  try {
    assert.deepEqual(sink.droppedColumns().tool_calls, ['input_summary']);
    const { counts } = await sink.write({
      operators: [op], runs: [run(3)], sessions: [session(3)],
      tool_calls: [{ tool_use_id: 'tu-1', session_id: 's-3', tool_name: 'Bash', input_summary: 'ls', input: { command: 'ls' }, is_error: false, line_no: 1 }],
    });
    assert.equal(counts.tool_calls, 1);
  } finally {
    await admin.query('alter table tool_calls add column if not exists input_summary text');
    await sink.close();
  }
});

test('sink scrubs NUL', { skip }, async () => {
  const sink = new Sink(URL_);
  await sink.open();
  try {
    await sink.write({
      operators: [op], runs: [run(4)], sessions: [session(4)],
      transcript_lines: [{ session_id: 's-4', line_no: 1, kind: 'user', body: { text: 'a\u0000b' } }],
    });
    const { rows } = await admin.query("select body->>'text' as t from transcript_lines where session_id = 's-4'");
    assert.equal(rows[0].t, 'a�b');
  } finally { await sink.close(); }
});

test('sink keeps rows of a missing table queued', { skip }, async () => {
  const ev = { id: 'sha-1', run_id: 'run-5', ticket_iid: 5, phase: 'design', lap: 0, kind: 'screenshot', source_path: 'design/a.png', path: 'run-5/sha-1.png', bytes: 10, operator_id: op.id };
  const payload = { operators: [op], runs: [run(5)], evidence: [ev] };
  await admin.query('alter table evidence rename to evidence_x');
  const sink = new Sink(URL_);
  try {
    await sink.open();
    const a = await sink.write(payload);
    assert.equal(a.counts.runs, 1);
    assert.equal(a.counts.evidence, 0);
    assert.deepEqual(a.skipped, ['evidence']);
    // The board migrates while the collector runs: the next write re-reads the schema.
    await admin.query('alter table evidence_x rename to evidence');
    const b = await sink.write(payload);
    assert.equal(b.counts.evidence, 1);
    assert.deepEqual(b.skipped, []);
  } finally {
    await admin.query('alter table if exists evidence_x rename to evidence');
    await sink.close();
  }
});

test('sink re-reads the schema after a column disappears mid-run', { skip }, async () => {
  const sink = new Sink(URL_);
  try {
    await sink.open();
    await admin.query('alter table tool_calls drop column input_summary');
    const payload = {
      operators: [op], runs: [run(6)], sessions: [session(6)],
      tool_calls: [{ tool_use_id: 'tu-6', session_id: 's-6', tool_name: 'Bash', input_summary: 'ls', is_error: false, line_no: 1 }],
    };
    await assert.rejects(sink.write(payload), (e) => e.code === '42703');
    const { counts } = await sink.write(payload);
    assert.equal(counts.tool_calls, 1);
  } finally {
    await admin.query('alter table tool_calls add column if not exists input_summary text');
    await sink.close();
  }
});

test('sink keeps the newer session when an older seq arrives', { skip }, async () => {
  const sink = new Sink(URL_);
  try {
    await sink.open();
    await sink.write({ operators: [op], runs: [run(7)], sessions: [{ ...session(7), seq: 5, status: 'ok' }] });
    await sink.write({ operators: [op], runs: [run(7)], sessions: [{ ...session(7), seq: 3, status: 'running' }] });
    const { rows } = await admin.query("select seq::int as seq, status from sessions where session_id = 's-7'");
    assert.deepEqual(rows[0], { seq: 5, status: 'ok' });
  } finally { await sink.close(); }
});

test('sink drops the seq guard on a board without sessions.seq', { skip }, async () => {
  await admin.query('alter table sessions drop column seq');
  const sink = new Sink(URL_);
  try {
    await sink.open();
    assert.deepEqual(sink.droppedColumns().sessions, ['seq']);
    const { counts } = await sink.write({ operators: [op], runs: [run(8)], sessions: [session(8)] });
    assert.equal(counts.sessions, 1);
  } finally {
    await admin.query('alter table sessions add column if not exists seq bigint not null default 0');
    await sink.close();
  }
});
