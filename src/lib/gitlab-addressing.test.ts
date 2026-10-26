/**
 * Addressing the project by path, and falling back to its numeric id only when
 * the path form is proven unroutable.
 *
 * The path form stays the default and the preferred one — see the comment on
 * projectSegment() in gitlab.ts. This file pins the fallback's two halves: that
 * it fires for an unmatched ROUTE, and that it does not fire for a resource
 * that is simply absent. Getting the second wrong would turn every missing
 * issue into two calls and a wrong-looking re-address.
 *
 * Runs against a stubbed fetch, IN ORDER: the module remembers its addressing
 * for the life of the process, so every case that needs the path form comes
 * before the one that flips it.
 */
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIssue, resolvedProjectId } from './gitlab.js';

process.env.GITLAB_READ_TOKEN = 'test-read-token';

const API = 'https://gitlab.example.com/api/v4';
const PATH_SEG = 'acme%2Ferp';
const ID = 304;

const calls: string[] = [];
let answer: (url: string) => Response = () => { throw new Error('no stub'); };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  return answer(url);
}) as typeof fetch;

/** GitLab's unmatched-route answer. */
const routeMissing = (): Response =>
  new Response(JSON.stringify({ error: '404 Not Found' }), { status: 404 });
/** GitLab's routed-but-absent answer. */
const resourceMissing = (what: string): Response =>
  new Response(JSON.stringify({ message: `404 ${what} Not Found` }), { status: 404 });
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

test('a healthy instance is addressed by path, with no extra call', async () => {
  answer = () => ok({ iid: 5, title: 'fine' });
  calls.length = 0;
  const res = await getIssue(5);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [`${API}/projects/${PATH_SEG}/issues/5`]);
});

test('an issue that is simply absent stays absent, in one call', async () => {
  // The expensive mistake to avoid. This 404 is routed; re-addressing it would
  // cost a search and a second request and report the wrong cause.
  answer = () => resourceMissing('Issue');
  calls.length = 0;
  const res = await getIssue(4242);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'notfound');
  assert.deepEqual(calls, [`${API}/projects/${PATH_SEG}/issues/4242`],
    'exactly one call: no search, no retry');
});

test('a near-match project is refused, and the path form is kept', async () => {
  // Addressing the wrong project would claim its tickets and push to it, so an
  // id is used only when `path_with_namespace` matches exactly.
  answer = (url) => {
    if (url.includes('/projects?search=')) {
      return ok([
        { id: 11, path_with_namespace: 'other/erp' },
        { id: 12, path_with_namespace: 'acme/erp-ci-templates' },
        { id: 13, path_with_namespace: 'ACME/ERP' },
      ]);
    }
    return routeMissing();
  };
  calls.length = 0;
  const res = await getIssue(7);
  assert.equal(res.ok, false, 'no id could be proven, so the original failure stands');
  assert.equal(calls.length, 2, 'the attempt and the search, and no retry');
  assert.ok(calls[1]?.includes('/projects?search=erp'));
  // Still on the path form, so the next case can exercise the flip.
  assert.ok(calls[0]?.includes(PATH_SEG));
});

test('a search that fails leaves the original failure and the path form', async () => {
  answer = (url) => (url.includes('/projects?search=') ? new Response('{}', { status: 500 }) : routeMissing());
  calls.length = 0;
  const res = await getIssue(8);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'notfound', 'the caller is told what it asked about, not about the search');
  assert.equal(calls.length, 2);
});

test('an unroutable path is re-addressed by the exactly-matching id, once', async () => {
  answer = (url) => {
    if (url.includes('/projects?search=')) {
      return ok([
        { id: 99, path_with_namespace: 'other/erp' },
        { id: ID, path_with_namespace: 'acme/erp' },
      ]);
    }
    if (url.includes(`/projects/${ID}/`)) return ok({ iid: 9, title: 'reached by id' });
    return routeMissing();
  };
  calls.length = 0;
  const res = await getIssue(9);
  assert.equal(res.ok, true);
  assert.equal(res.data?.title, 'reached by id');
  assert.deepEqual(calls, [
    `${API}/projects/${PATH_SEG}/issues/9`,
    `${API}/projects?search=erp&simple=true&membership=true&per_page=100`,
    `${API}/projects/${ID}/issues/9`,
  ], 'attempt, search, retry — in that order');
});

test('once re-addressed, later calls go straight to the id', async () => {
  // The cost of the fallback is one extra round trip per process, not per call.
  answer = () => ok({ iid: 10, title: 'direct' });
  calls.length = 0;
  const res = await getIssue(10);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [`${API}/projects/${ID}/issues/10`]);
});

test('only the project segment is rewritten, never the rest of the path', async () => {
  answer = () => ok([]);
  calls.length = 0;
  await getIssue(11);
  assert.equal(calls[0], `${API}/projects/${ID}/issues/11`,
    'the iid and the endpoint survive the re-addressing');
});

test('the id found this way answers resolvedProjectId without asking again', async () => {
  answer = () => { throw new Error('resolvedProjectId must not need the network here'); };
  calls.length = 0;
  assert.equal(await resolvedProjectId(), ID);
  assert.deepEqual(calls, []);
});
