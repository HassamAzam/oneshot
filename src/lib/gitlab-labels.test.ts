/**
 * listLabels() reading every page of the project's labels.
 *
 * GitLab caps `per_page` at 100 and arbisoft/erp carries over 300 labels, so a
 * single request read the first hundred and doctor reported every label on
 * the other pages as "does not exist on the project" — the three local-tests
 * labels among them. These pin that the pages are walked to the short one,
 * and that a page failing half-way fails the whole read rather than passing
 * off a partial list as the project's.
 *
 * Nothing touches the network or this machine's credentials: fetch is a stub
 * and the read token is pinned for the case, then restored.
 */
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listLabels } from './gitlab.js';

const LABELS = 'https://gitlab.example.com/api/v4/projects/acme%2Ferp/labels';

/** `n` labels named `label-<i>`, the way a page of GET …/labels answers. */
const page = (from: number, n: number): Array<{ name: string }> =>
  Array.from({ length: n }, (_, i) => ({ name: `label-${from + i}` }));

/**
 * Run listLabels with fetch answered by `reply` (by page number) and the read
 * token pinned, then put this machine's fetch and variable back. Returns what
 * was asked for, so "stopped at the short page" is provable.
 */
async function read(
  reply: (pageNo: number) => Response,
): Promise<{ result: Awaited<ReturnType<typeof listLabels>>; urls: string[] }> {
  const realFetch = globalThis.fetch;
  const before = process.env.GITLAB_READ_TOKEN;
  const urls: string[] = [];
  process.env.GITLAB_READ_TOKEN = 'glpat-fake-read-token';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    return reply(Number(new URL(url).searchParams.get('page')));
  }) as typeof fetch;
  try {
    return { result: await listLabels(), urls };
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITLAB_READ_TOKEN;
    else process.env.GITLAB_READ_TOKEN = before;
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test('every page is read, so a label past the first hundred is found', async () => {
  // 327 labels, as on arbisoft/erp when this was written: 100 + 100 + 100 + 27.
  const { result, urls } = await read((n) => json(n <= 3 ? page((n - 1) * 100, 100) : page(300, 27)));
  assert.equal(result.ok, true);
  assert.equal(result.data?.length, 327);
  assert.ok(result.data?.some((l) => l.name === 'label-326'), 'the last label on the last page is there');
  assert.deepEqual(urls, [1, 2, 3, 4].map((n) => `${LABELS}?per_page=100&page=${n}`));
});

test('a project with fewer than a hundred labels costs one request', async () => {
  const { result, urls } = await read(() => json(page(0, 12)));
  assert.equal(result.data?.length, 12);
  assert.equal(urls.length, 1);
});

test('exactly a hundred labels asks once more and stops on the empty page', async () => {
  const { result, urls } = await read((n) => json(n === 1 ? page(0, 100) : []));
  assert.equal(result.data?.length, 100);
  assert.equal(urls.length, 2);
});

test('a page failing half-way fails the read, never a partial list', async () => {
  // A list missing its second page would report every label on it as absent:
  // the very false alarm paging exists to stop.
  const { result } = await read((n) => (n === 1 ? json(page(0, 100)) : json({ message: 'boom' }, 500)));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'server');
  assert.equal(result.data, null);
});
