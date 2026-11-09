/**
 * The gate rows the collector ships, and the merge-answerer lookup. Pure: no
 * network (fetch is injected), no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatesFor } from './gates.mjs';
import { mergedBy, mergerCache } from './mrmerger.mjs';

const base = (extra = {}) => ({ runId: 'r1', iid: 7, reviewMode: true, phases: [], ...extra });
const row = (rows, gate) => rows.find((r) => r.gate === gate);

test('gates emits a design row once design.json exists', () => {
  const rows = gatesFor(base({ designApproval: { approved: true, approvedBy: 'ali', feedback: [] } }), 'op');
  const d = row(rows, 'design');
  assert.ok(d, 'design row present');
  assert.equal(d.state, 'approved');
  assert.equal(d.approved_by, 'ali');
  assert.equal(d.id, 'r1:design');
});

test('gates tolerate old journal', () => {
  const rows = gatesFor(base({ planApproval: { approved: false, requestTs: 1, feedback: ['tighten step 2'] } }), 'op');
  const p = row(rows, 'plan');
  assert.equal(p.state, 'waiting');
  assert.equal(p.approved_by, null);
  assert.deepEqual(p.feedback_by, []);
  assert.equal(p.rounds, 1);
});

test('merge row carries mergedBy when given', () => {
  const rows = gatesFor(base({ mrIid: 42, mergedSha: 'abc', humanMergeCheckAt: 1_700_000_000_000 }), 'op', 'bob');
  const m = row(rows, 'merge');
  assert.equal(m.state, 'approved');
  assert.equal(m.approved_by, 'bob');
  assert.deepEqual(m.feedback_by, []);
  assert.equal(m.rounds, 0);
  assert.equal(m.requested_at, new Date(1_700_000_000_000).toISOString());
});

test('merge row is approved with mergedBy once mergedSha is set', () => {
  const before = row(gatesFor(base({ mrIid: 42 }), 'op'), 'merge');
  assert.equal(before.state, 'pending');
  assert.equal(before.approved_by, null);
  const waiting = row(gatesFor(base({ mrIid: 42, humanMergeCheckAt: 5 }), 'op'), 'merge');
  assert.equal(waiting.state, 'waiting');
  const unknown = row(gatesFor(base({ mrIid: 42, mergedSha: 'abc' }), 'op'), 'merge');
  assert.equal(unknown.state, 'approved');
  assert.equal(unknown.approved_by, null);
  assert.equal(row(gatesFor(base(), 'op'), 'merge'), undefined, 'no MR, no merge row');
});

test('gates skips verifycases until verify ran', () => {
  assert.equal(row(gatesFor(base(), 'op'), 'verifycases'), undefined);
  const ran = gatesFor(base({ phases: [{ phase: 'verify', status: 'ok' }, { phase: 'research', status: 'ok' }] }), 'op');
  assert.equal(row(ran, 'verifycases'), undefined, 'verify finishing does not arm the gate');
  assert.equal(row(ran, 'notabug'), undefined, 'research finishing does not arm the gate');
  const fed = gatesFor(base({ verifyCasesApproval: { approved: false, requestTs: 2, feedback: ['a', 'b'], feedbackBy: [['ali'], ['bob', 'cy']] } }), 'op');
  assert.equal(row(fed, 'verifycases').state, 'waiting');
  assert.deepEqual(row(fed, 'verifycases').feedback_by, [['ali'], ['bob', 'cy']]);
  const nab = row(gatesFor(base({ notABugApproval: { approved: true, approvedBy: 'dee' } }), 'op'), 'notabug');
  assert.equal(nab.state, 'approved');
  assert.equal(nab.approved_by, 'dee');
  assert.deepEqual(nab.feedback_by, []);
  const noGates = { ...base({ mrIid: 42, mergedSha: 'abc', phases: [{ phase: 'design', status: 'ok' }, { phase: 'plan', status: 'ok' }] }), reviewMode: false };
  assert.deepEqual(gatesFor(noGates, 'op', 'bob'), [], 'outside Review: no placeholders, no merge row');
});

test('gates emits an armed gate on a non-Review run', () => {
  const j = {
    ...base({ designApproval: { approved: true, approvedBy: 'ali' }, mrIid: 42, mergedSha: 'abc', phases: [{ phase: 'plan', status: 'ok' }, { phase: 'testcases', status: 'ok' }] }),
    reviewMode: false,
  };
  const rows = gatesFor(j, 'op', 'bob');
  assert.deepEqual(rows.map((r) => r.gate), ['design'], 'the design gate only: no plan/testcases placeholders, no merge row');
  assert.equal(rows[0].state, 'approved');
  assert.equal(rows[0].approved_by, 'ali');
});

test('a gate armed by its request note is waiting', () => {
  const p = row(gatesFor(base({ planApproval: { approved: false, requestTs: null, requestNoteId: 300345, feedback: [] } }), 'op'), 'plan');
  assert.equal(p.state, 'waiting');
  const fed = row(gatesFor(base({ planApproval: { approved: false, requestTs: null, requestNoteId: null, feedback: ['x'] } }), 'op'), 'plan');
  assert.equal(fed.state, 'waiting', 'a re-armed gate with feedback rounds is still waiting on a person');
  const blank = row(gatesFor(base({ planApproval: { approved: false, requestTs: null, requestNoteId: null, feedback: [] } }), 'op'), 'plan');
  assert.equal(blank.state, 'pending');
});

test('verifycases takes its answerers from the per-case decisions', () => {
  const j = base({
    verifyCasesApproval: { approved: true, feedback: [] },
    verifyCaseDecisions: [{ caseId: 'TC-01', verdict: 'skip', by: 'qa1' }, { caseId: 'TC-02', verdict: 'expected', by: 'qa2' }],
  });
  const v = row(gatesFor(j, 'op'), 'verifycases');
  assert.equal(v.state, 'approved');
  assert.equal(v.approved_by, 'qa2');
  assert.deepEqual(v.feedback_by, [['qa1', 'qa2']]);

  const open = row(gatesFor({ ...j, verifyCasesApproval: { approved: false, requestNoteId: 9, feedback: [] } }, 'op'), 'verifycases');
  assert.equal(open.approved_by, null, 'not approved, no approver');
  const none = row(gatesFor(base({ verifyCasesApproval: { approved: false, requestNoteId: 9, feedback: [] } }), 'op'), 'verifycases');
  assert.deepEqual(none.feedback_by, []);
  // The other gates never read the decisions.
  const plan = row(gatesFor({ ...j, planApproval: { approved: true, feedback: [] } }, 'op'), 'plan');
  assert.equal(plan.approved_by, null);
  assert.deepEqual(plan.feedback_by, []);
});

test('mergerCache persists run → username, keeps null distinct from missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mergers-'));
  const c = mergerCache(dir);
  assert.equal(c.get('r1'), undefined);
  c.set('r1', 'bob');
  c.set('r2', null);
  c.save();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mergers.json'), 'utf8')), { r1: 'bob', r2: null });
  const again = mergerCache(dir);
  assert.equal(again.get('r1'), 'bob');
  assert.equal(again.get('r2'), null);
  assert.equal(again.get('r3'), undefined);
});

const env = { GITLAB_REPO_URL: 'https://gitlab.example.com/grp/proj', GITLAB_TOKEN: 'tok-shared' };

test('mergedBy asks GitLab for the MR with PRIVATE-TOKEN and reads merge_user', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ merge_user: { username: 'bob' }, merged_by: { username: 'old' } }) };
  };
  assert.equal(await mergedBy(42, { fetch, env }), 'bob');
  assert.equal(calls[0].url, 'https://gitlab.example.com/api/v4/projects/grp%2Fproj/merge_requests/42');
  assert.equal(calls[0].init.headers['PRIVATE-TOKEN'], 'tok-shared');
  assert.ok(calls[0].init.signal, 'a timeout signal is set');

  const prefer = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ merged_by: { username: 'old' } }) }; };
  assert.equal(await mergedBy(43, { fetch: prefer, env: { ...env, ONESHOT_GITLAB_TOKEN: 'tok-desk', GITLAB_READ_TOKEN: 'tok-read' } }), 'old');
  assert.equal(calls[1].init.headers['PRIVATE-TOKEN'], 'tok-read');
});

test('mergedBy returns null on any failure and never throws', async () => {
  const throws = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await mergedBy(42, { fetch: throws, env }), null);
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{"message":"404 Not found"}' });
  assert.equal(await mergedBy(42, { fetch: notFound, env }), null);
  const unmerged = async () => ({ ok: true, status: 200, json: async () => ({ merge_user: null }) });
  assert.equal(await mergedBy(42, { fetch: unmerged, env }), null);
  let called = false;
  const spy = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.equal(await mergedBy(42, { fetch: spy, env: { GITLAB_TOKEN: 'x' } }), null, 'no repo URL');
  assert.equal(await mergedBy(42, { fetch: spy, env: { GITLAB_REPO_URL: env.GITLAB_REPO_URL } }), null, 'no token');
  assert.equal(called, false, 'nothing is fetched without a repo URL and a token');
});

test('mergedBy falls back to the numeric project id when GitLab answers a route-404', async () => {
  const urls = [];
  const res = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url) => {
    urls.push(url);
    if (url.includes('grp%2Fproj2')) return res(404, { error: '404 Not Found' });
    if (url.includes('/projects?search=proj2')) return res(200, [{ id: 9, path_with_namespace: 'grp/proj2-old' }, { id: 304, path_with_namespace: 'grp/proj2' }]);
    if (url.endsWith('/projects/304/merge_requests/5')) return res(200, { merge_user: { username: 'cy' } });
    return res(500, {});
  };
  const e = { GITLAB_REPO_URL: 'https://gitlab.example.com/grp/proj2', GITLAB_TOKEN: 't' };
  assert.equal(await mergedBy(5, { fetch, env: e }), 'cy');
  assert.deepEqual(urls.slice(1), [
    'https://gitlab.example.com/api/v4/projects?search=proj2&simple=true&membership=true&per_page=100',
    'https://gitlab.example.com/api/v4/projects/304/merge_requests/5',
  ]);
  urls.length = 0;
  assert.equal(await mergedBy(5, { fetch, env: e }), 'cy');
  assert.deepEqual(urls, ['https://gitlab.example.com/api/v4/projects/304/merge_requests/5'], 'the id is remembered');

  const missing = async (url) => { urls.push(url); return res(404, { message: '404 Not found' }); };
  urls.length = 0;
  assert.equal(await mergedBy(6, { fetch: missing, env: { ...e, GITLAB_REPO_URL: 'https://gitlab.example.com/grp/proj3' } }), null);
  assert.equal(urls.length, 1, 'a resource-404 is an answer, not a reason to re-address');
});
