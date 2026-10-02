/**
 * What the authoring session is handed, read by the conductor over REST: the
 * ticket and its people's comments, and the diff of every merged fix MR —
 * paginated, all or nothing, only the merged ones — then bounded so one huge
 * MR cannot crowd everything else out of the prompt.
 *
 * Runs against a stubbed fetch. Invented numbers throughout: ticket 101, fix
 * MRs !501 and !502, abandoned MR !400.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRequestDiffs, type MrDiff } from '../lib/gitlab.js';
import {
  DIFF_CAPS, clip, fetchAutomationTicket, fetchMergedChanges, renderChanges, skipReason, truncated,
  type DiffCaps, type MergedChange,
} from './context.js';
import type { MrRef } from './readiness.js';

// Set rather than inherited, so this machine's .env cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';

const API = 'https://gitlab.example.com/api/v4/projects/acme%2Ferp';
const calls: string[] = [];
let answer: (url: string) => Response = () => { throw new Error('offline'); };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  return answer(url);
}) as typeof fetch;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const file = (path: string, diff = '@@ -1 +1 @@\n-a\n+b\n', over: Partial<MrDiff> = {}): MrDiff => ({
  old_path: path, new_path: path, diff, new_file: false, renamed_file: false, deleted_file: false, ...over,
});

const mr = (iid: number, over: Partial<MrRef> = {}): MrRef => ({
  iid, title: `Fix ${iid}`, source: `fix/${iid}`, target: 'dev', state: 'merged',
  mergedAt: '2026-09-08T10:00:00Z', url: `https://gitlab.example.com/acme/erp/-/merge_requests/${iid}`, ...over,
});

const pageOf = (n: number, from = 0): MrDiff[] => Array.from({ length: n }, (_, i) => file(`apps/f${from + i}.py`));

// ------------------------------------------------------------------ fetching

test('mergeRequestDiffs reads 100 files a page until a short page, in order', async () => {
  calls.length = 0;
  answer = (url) => {
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1]);
    return json(page === 1 ? pageOf(100) : pageOf(3, 100));
  };
  const res = await mergeRequestDiffs(501);
  assert.equal(res.ok, true);
  assert.equal(res.data?.files.length, 103);
  assert.equal(res.data?.complete, true);
  assert.equal(res.data?.files[102]?.new_path, 'apps/f102.py');
  assert.deepEqual(calls, [
    `${API}/merge_requests/501/diffs?per_page=100&page=1`,
    `${API}/merge_requests/501/diffs?per_page=100&page=2`,
  ]);
});

test('mergeRequestDiffs is all or nothing, and says when it stopped at its page limit', async () => {
  answer = (url) => (url.includes('page=2') ? json({ message: 'boom' }, 500) : json(pageOf(100)));
  const failed = await mergeRequestDiffs(501);
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, 'server');
  assert.equal(failed.data, null, 'a half-read change is not returned');

  calls.length = 0;
  answer = () => json(pageOf(100));
  const capped = await mergeRequestDiffs(501);
  assert.equal(capped.ok, true);
  assert.equal(capped.data?.complete, false);
  assert.equal(calls.length, 30, 'a misbehaving API cannot loop forever');
});

test('fetchMergedChanges reads only the merged MRs it is given: description and diff, nothing else', async () => {
  calls.length = 0;
  answer = (url) => {
    if (url.endsWith('/merge_requests/501')) return json({ iid: 501, state: 'merged', description: 'Rejects big files.' });
    if (url.endsWith('/merge_requests/502')) return json({ iid: 502, state: 'merged', description: null });
    if (url.includes('/merge_requests/501/diffs')) return json([file('apps/profile/views.py')]);
    if (url.includes('/merge_requests/502/diffs')) return json([file('apps/profile/forms.py')]);
    return json({ message: 'not found' }, 404);
  };
  // A stale list holding an open MR: it is never asked for.
  const res = await fetchMergedChanges([mr(501), mr(400, { state: 'opened', mergedAt: null }), mr(502)]);
  assert.ok(res.ok);
  assert.deepEqual(res.changes.map((c) => [c.mr.iid, c.description, c.files.map((f) => f.new_path), c.complete]), [
    [501, 'Rejects big files.', ['apps/profile/views.py'], true],
    [502, null, ['apps/profile/forms.py'], true],
  ]);
  assert.ok(!calls.some((u) => u.includes('/merge_requests/400')), 'the open MR is never read');
  assert.ok(calls.every((u) => u.startsWith(`${API}/merge_requests/50`)), 'only merge-request reads');
});

test('fetchMergedChanges fails as a whole when any merged MR cannot be read', async () => {
  answer = (url) => {
    if (url.endsWith('/merge_requests/501')) return json({ iid: 501, state: 'merged', description: '' });
    if (url.includes('/merge_requests/501/diffs')) return json([file('a.py')]);
    if (url.endsWith('/merge_requests/502')) return json({ iid: 502, state: 'merged', description: '' });
    return json({ message: '403 Forbidden' }, 403);
  };
  const res = await fetchMergedChanges([mr(501), mr(502)]);
  assert.deepEqual(res, { ok: false, error: 'cannot read the diff of !502 (auth 403)' });
});

test('fetchAutomationTicket keeps the comments people wrote, with author and date, and the ticket state', async () => {
  answer = (url) => {
    if (url.endsWith('/issues/101')) {
      return json({
        iid: 101, title: 'Profile docs', description: 'It fails.', labels: ['Profile'], state: 'closed',
        web_url: 'https://gitlab.example.com/acme/erp/-/issues/101', updated_at: '2026-09-28T10:00:00Z',
      });
    }
    if (url.includes('/issues/101/notes')) {
      return json([
        { id: 1, body: 'Also check the 5 MB limit.', author: { username: 'qa.person' }, created_at: '2026-09-02T10:00:00Z' },
        { id: 2, body: 'added ~"Ready For Automation" label', system: true, author: { username: 'qa.person' } },
        { id: 3, body: '**Automation test cases: v1**\n<!-- oneshot:automation:cases:v1:0123456789ab -->', author: { username: 'desk' } },
        { id: 4, body: 'Oneshot stopped: the run was blocked.', author: { username: 'desk' } },
        { id: 5, body: 'Contractors too, please.', author: { username: 'po.person' }, created_at: '2026-09-03T09:00:00Z' },
      ]);
    }
    return json({}, 404);
  };
  const t = await fetchAutomationTicket(101);
  assert.ok(t);
  assert.equal(t.state, 'closed');
  assert.equal(t.url, 'https://gitlab.example.com/acme/erp/-/issues/101');
  assert.deepEqual(t.comments, [
    { author: 'qa.person', at: '2026-09-02T10:00:00Z', body: 'Also check the 5 MB limit.' },
    { author: 'po.person', at: '2026-09-03T09:00:00Z', body: 'Contractors too, please.' },
  ]);
});

// ------------------------------------------------------------------ bounding

const change = (files: MrDiff[], over: Partial<MergedChange> = {}): MergedChange => ({
  mr: mr(501), description: 'Rejects big files.', files, complete: true, ...over,
});

const lines = (n: number, prefix = '+line'): string => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');

test('skipReason names lockfiles, minified, generated and binary files, and nothing else', () => {
  assert.equal(skipReason(file('frontend/package-lock.json')), 'lockfile');
  assert.equal(skipReason(file('poetry.lock')), 'lockfile');
  assert.equal(skipReason(file('static/app.min.js')), 'minified or source map');
  assert.equal(skipReason(file('static/app.js.map')), 'minified or source map');
  assert.equal(skipReason(file('api/schema.ts', 'x', { generated_file: true })), 'generated');
  assert.equal(skipReason(file('src/__snapshots__/Form.test.js.snap')), 'generated');
  assert.equal(skipReason(file('docs/flow.png', '')), 'binary or image');
  assert.equal(skipReason(file('fixtures/blob.dat', 'Binary files a/fixtures/blob.dat and b/fixtures/blob.dat differ\n')), 'binary or image');
  assert.equal(skipReason(file('apps/users/views.py')), null);
  assert.equal(skipReason(file('apps/users/migrations/0042_add_pref.py')), null, 'a migration is shown, head only');
});

test('skipped files are named with their reason and size but never shown', () => {
  const out = renderChanges([change([
    file('frontend/package-lock.json', lines(5000)),
    file('static/app.min.js', '+var a=1;'),
    file('docs/flow.png', ''),
    file('apps/users/views.py', '@@ -1 +1 @@\n-old\n+new'),
  ])]);
  assert.match(out, /^##### !501 frontend\/package-lock\.json \(modified\) — lockfile, not shown \(5,000 lines\)$/m);
  assert.match(out, /^##### !501 static\/app\.min\.js \(modified\) — minified or source map, not shown \(1 line\)$/m);
  assert.match(out, /^##### !501 docs\/flow\.png \(modified\) — binary or image, not shown$/m);
  assert.ok(!out.includes('+line 4999'), 'the lockfile body is not in the prompt');
  assert.match(out, /##### !501 apps\/users\/views\.py \(modified\)\n```diff\n@@ -1 \+1 @@\n-old\n\+new\n```/);
  assert.doesNotMatch(out, /\[truncated/, 'nothing shown was cut');
});

test('a migration shows only its head, marked', () => {
  const out = renderChanges([change([file('apps/users/migrations/0042_add_pref.py', lines(100), { new_file: true })])]);
  assert.match(out, /##### !501 apps\/users\/migrations\/0042_add_pref\.py \(new file\)\n```diff\n\+line 0\n/);
  assert.ok(out.includes('+line 39') && !out.includes('+line 40'));
  assert.match(out, /\n```\n\[truncated 60 lines\] — a migration shows only its head/);
});

test('each file is capped, and so is the whole change, every cut marked with [truncated N lines]', () => {
  const caps: DiffCaps = { ...DIFF_CAPS, fileLines: 10, totalLines: 25 };
  const out = renderChanges([
    change([file('a.py', lines(30)), file('b.py', lines(8))]),
    change([file('c.py', lines(20)), file('d.py', lines(5))], { mr: mr(502) }),
  ], caps);
  // a.py: its own cap. b.py: whole. c.py: the 7 lines the change has left. d.py: nothing left.
  assert.match(out, /##### !501 a\.py \(modified\)\n```diff\n(\+line \d+\n){10}```\n\[truncated 20 lines\] — one file shows at most 10 lines or 30,000 characters/);
  assert.match(out, /##### !501 b\.py \(modified\)\n```diff\n(\+line \d+\n){8}```\n\n/);
  assert.match(out, /##### !502 c\.py \(modified\)\n```diff\n(\+line \d+\n){7}```\n\[truncated 13 lines\] — the diff budget for the whole change is used up/);
  assert.match(out, /##### !502 d\.py \(modified\)\n\[truncated 5 lines\] — the diff budget for the whole change is used up/);
  assert.match(out, /\[truncated 38 lines\] across 3 files in all: the diff above is not the whole change\.$/);
  assert.match(out, /^### !502 Fix 502 \(fix\/502 → dev, merged 2026-09-08\)$/m, 'every MR is still named');
});

test('the character caps hold too: a long line is cut, and a file of long lines stops at its character cap', () => {
  const caps: DiffCaps = { ...DIFF_CAPS, lineChars: 50, fileChars: 400 };
  const out = renderChanges([change([file('bundle.js', Array.from({ length: 40 }, () => `+${'x'.repeat(200)}`).join('\n'))])], caps);
  assert.match(out, /\+x{49} … \[line cut at 50 of 201 chars\]/);
  const shown = (out.match(/\[line cut at 50 of 201 chars\]/g) ?? []).length;
  assert.ok(shown > 0 && shown < 40, `${shown} lines shown`);
  assert.match(out, new RegExp(`\\[truncated ${40 - shown} lines\\]`));
});

test('past listedFiles, files are only counted; a withheld or incomplete diff is said out loud', () => {
  const caps: DiffCaps = { ...DIFF_CAPS, listedFiles: 3 };
  const out = renderChanges([change([
    file('a.py'), file('b.py', '', { too_large: true, collapsed: true }), file('c.py', '', { renamed_file: true, old_path: 'old/c.py' }),
    file('d.py'), file('e.py'),
  ], { complete: false })], caps);
  assert.match(out, /^##### !501 b\.py \(modified\) — GitLab did not return this diff: it is too large$/m);
  assert.match(out, /^##### !501 c\.py \(renamed from old\/c\.py\) — no line changes$/m);
  assert.doesNotMatch(out, /d\.py/);
  assert.match(out, /^\[2 more changed files not listed: the change names more files than are shown here\]$/m);
  assert.match(out, /^#### Files changed in !501 \(5\+, more than GitLab lists here\)$/m);
  assert.match(out, /GitLab lists more files in !501 than are read here, so the files above are not the whole change\./);
});

test('an MR description is fenced and capped like a diff', () => {
  const caps: DiffCaps = { ...DIFF_CAPS, descriptionLines: 3 };
  const out = renderChanges([change([file('a.py')], { description: 'one\ntwo\nthree\nfour\nfive' })], caps);
  assert.match(out, /#### Description of !501\n```text\none\ntwo\nthree\n```\n\[truncated 2 lines\]/);
  assert.match(renderChanges([change([file('a.py')], { description: null })]), /#### Description of !501\n\(empty\)/);
});

test('clip keeps whole lines and counts what it left out; truncated() is the one marker wording', () => {
  assert.deepEqual(clip('a\nb\nc\n', 2, 100), { kept: ['a', 'b'], cut: 1, chars: 4 });
  assert.deepEqual(clip('aaaa\nb', 10, 4), { kept: [], cut: 2, chars: 0 }, 'a line is never split across the limit');
  assert.equal(truncated(1), '[truncated 1 line]');
  assert.equal(truncated(12), '[truncated 12 lines]');
});
