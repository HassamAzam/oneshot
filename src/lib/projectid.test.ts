/**
 * The project's identity on the wire is its URL-encoded path, and its numeric id
 * is something GitLab is asked for — never configured. These pin both halves:
 * every call addresses `/projects/<group%2Fproject>`, and the one consumer of the
 * number (a ticket's `/-/project/<id>/uploads/` links) gets it from GitLab, keeps
 * it, and refuses to guess when GitLab cannot be asked.
 *
 * Runs against a stubbed fetch, in order: the module remembers a resolved id for
 * the life of the process, so the failure cases come before the success.
 */
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIssue, projectUrl, resolvedProjectId } from './gitlab.js';
import { collectTicketDocs } from './ticketdocs.js';

// Set rather than inherited, so this machine's .env cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';

const API = 'https://gitlab.example.com/api/v4';
const SECRET = '275920f75d842b9067ea1e8f0a621a45';
const calls: string[] = [];
let answer: (url: string) => Response = () => { throw new Error('offline'); };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  return answer(url);
}) as typeof fetch;

test('every project call addresses the URL-encoded path, not a configured number', async () => {
  answer = () => new Response(JSON.stringify({ iid: 5 }), { status: 200 });
  calls.length = 0;
  await getIssue(5);
  assert.deepEqual(calls, [`${API}/projects/acme%2Ferp/issues/5`]);
  assert.equal(projectUrl(), 'https://gitlab.example.com/acme/erp');
});

test('with GitLab unreachable there is no id, and nothing is remembered', async () => {
  answer = () => { throw new Error('connect ETIMEDOUT'); };
  calls.length = 0;
  assert.equal(await resolvedProjectId(), null);
  assert.equal(await resolvedProjectId(), null);
  // Asked both times: a failure must not stick.
  assert.equal(calls.length, 2);
});

test('an id-scoped upload link that cannot be proven ours is skipped, not fetched', async () => {
  answer = () => { throw new Error('connect ETIMEDOUT'); };
  calls.length = 0;
  const { documents } = await collectTicketDocs(424242, [
    { where: 'description', body: `[flow](/-/project/42/uploads/${SECRET}/flow.pdf)` },
  ]);
  assert.deepEqual(documents, []);
  assert.deepEqual(calls, [`${API}/projects/acme%2Ferp?statistics=false`]);
});

test('the id is asked of GitLab once and then remembered', async () => {
  answer = () => new Response(JSON.stringify({ id: 42 }), { status: 200 });
  calls.length = 0;
  assert.equal(await resolvedProjectId(), 42);
  assert.equal(await resolvedProjectId(), 42);
  assert.deepEqual(calls, [`${API}/projects/acme%2Ferp?statistics=false`]);
});

test('with the id known, our own id-scoped upload is fetched and another project\'s is not', async () => {
  // The download answers 404 so nothing is written to disk; the request is the point.
  answer = () => new Response('not found', { status: 404 });
  calls.length = 0;
  const { documents } = await collectTicketDocs(424242, [
    { where: 'description', body: `[ours](/-/project/42/uploads/${SECRET}/ours.pdf)` },
    { where: 'comment 1', body: `[theirs](/-/project/7/uploads/${SECRET}/theirs.pdf)` },
  ]);
  assert.deepEqual(documents.map((d) => d.name), ['ours.pdf']);
  assert.deepEqual(calls, [`${API}/projects/acme%2Ferp/uploads/${SECRET}/ours.pdf`]);
});
