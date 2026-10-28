/**
 * A GitLab front end that decodes %2F redirects /projects/group%2Fproject to
 * /projects/group/project, which 404s. ping() then finds the numeric id through
 * the project search and every later call is addressed by that number.
 */
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIssue, ping, resolvedProjectId } from './gitlab.js';

process.env.GITLAB_READ_TOKEN = 'test-read-token';

const API = 'https://gitlab.example.com/api/v4';
const calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  if (url.startsWith(`${API}/projects?search=`)) {
    return new Response(JSON.stringify([
      { id: 7, path_with_namespace: 'acme/erp-legacy' },
      { id: 42, path_with_namespace: 'acme/erp' },
    ]), { status: 200 });
  }
  if (url.includes('acme%2Ferp')) return new Response('{"message":"404 Project Not Found"}', { status: 404 });
  if (url.startsWith(`${API}/projects/42`)) return new Response(JSON.stringify({ id: 42, iid: 5 }), { status: 200 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

test('a 404 on the encoded path falls back to the searched numeric id', async () => {
  const res = await ping();
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    `${API}/projects/acme%2Ferp?statistics=false`,
    `${API}/projects?search=acme%2Ferp&search_namespaces=true&simple=true&per_page=100`,
    `${API}/projects/42?statistics=false`,
  ]);
  assert.equal(await resolvedProjectId(), 42);
});

test('once resolved, project calls are addressed by number', async () => {
  calls.length = 0;
  await getIssue(5);
  assert.deepEqual(calls, [`${API}/projects/42/issues/5`]);
});
