import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  GOOGLE_DOC, GOOGLE_SHEET, demoPdfHtml, packEntries, renderFindingsMd, renderReadmeMd, renderResearchMd,
  ticketFolderName, type PackInput,
} from './drivepack.js';
import { consentUrl, signJwt, tokenRequest } from './gdrive.js';

const ISSUE = 'https://gitlab.arbisoft.com/arbisoft/erp/-/issues/9002';

const base = (over: Partial<PackInput> = {}): PackInput => ({
  iid: 9002, title: 'Page titles', issueUrl: ISSUE, phases: [],
  research: null, plan: null, testcasesCsv: null, verify: null, findings: null, shots: [], demoVideo: null,
  ...over,
});

test('the folder is named <iid> — <title>, flattened and capped', () => {
  assert.equal(ticketFolderName(9002, '[Story] WEB: Page titles'), '9002 — [Story] WEB: Page titles');
  assert.equal(ticketFolderName(7, 'a\n\tb   c'), '7 — a b c');
  assert.equal(ticketFolderName(7, '  '), '7');
  const long = ticketFolderName(7, 'x'.repeat(300));
  assert.ok(long.length <= 115 && long.endsWith('…'));
});

test('a run with no artifacts yet still gets a README linking the full issue URL', () => {
  const entries = packEntries(base());
  assert.deepEqual(entries.map((e) => e.key), ['readme']);
  const readme = entries[0]!;
  assert.equal(readme.convertTo, GOOGLE_DOC);
  assert.equal(readme.source.kind, 'text');
  assert.match((readme.source as { text: string }).text, new RegExp(ISSUE.replace(/[/.]/g, '\\$&')));
});

test('every artifact maps to one named entry, in folder order, with screenshots last', () => {
  const shots = [
    { file: '01-a.png', path: '/r/01-a.png', caption: 'first' },
    { file: '02-b.png', path: '/r/02-b.png', caption: 'second', caseId: 'TC-1' },
  ];
  const entries = packEntries(base({
    research: { summary: 's' }, plan: '# plan', testcasesCsv: 'ID\nTC-1', verify: { results: [] },
    findings: { verdict: 'approve', findings: [] }, shots, demoVideo: '/r/demo/demo.webm',
    mrUrl: 'https://gitlab.arbisoft.com/arbisoft/erp/-/merge_requests/1',
  }));
  assert.deepEqual(entries.map((e) => [e.key, e.name]), [
    ['readme', '00 README'],
    ['research', '01 Research'],
    ['plan', '02 Plan'],
    ['testcases', '03 Test cases'],
    ['verify', '04 Verification'],
    ['review', '05 Review findings'],
    ['demo-pdf', '06 Demo — screenshots.pdf'],
    ['demo-video', '07 Demo video.webm'],
    ['shot:01-a.png', '01-a.png'],
    ['shot:02-b.png', '02-b.png'],
  ]);
  const by = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(by.testcases!.convertTo, GOOGLE_SHEET);
  assert.equal(by['demo-pdf']!.convertTo, undefined);
  assert.equal(by['demo-video']!.mime, 'video/webm');
  assert.ok(by['shot:01-a.png']!.inShots);
  const pdf = by['demo-pdf']!.source;
  assert.equal(pdf.kind, 'pdf');
  assert.deepEqual((pdf as { shots: unknown[] }).shots, shots);
  const readme = (by.readme!.source as { text: string }).text;
  assert.match(readme, /merge_requests\/1/);
  assert.match(readme, /Screenshots\/ \(2 image\(s\)\)/);
});

test('keys are stable across titles, so a renamed ticket never duplicates its files', () => {
  const a = packEntries(base({ title: 'one', research: { summary: 's' } })).map((e) => e.key);
  const b = packEntries(base({ title: 'two', research: { summary: 's' } })).map((e) => e.key);
  assert.deepEqual(a, b);
});

test('the README holds no clock, so an unchanged run hashes the same on every pass', () => {
  const input = base({ phases: [{ phase: 'plan', lap: 1, status: 'ok', startedAt: 1, endedAt: 2 }] });
  assert.equal(renderReadmeMd(input, []), renderReadmeMd(input, []));
});

test('research renders the sections GitLab never sees, skipping empty ones', () => {
  const md = renderResearchMd(9002, 'T', ISSUE, {
    summary: 'Sum', acceptanceCriteria: ['AC1'], codePath: [{ file: 'a.py', line: 3, role: 'x | y' }],
    unknowns: [], reproduction: { verdict: 'not-applicable' },
  });
  assert.match(md, /^# Research — 9002 T/);
  assert.match(md, /- AC1/);
  assert.match(md, /\| a\.py \| 3 \| x \\\| y \|/);
  assert.doesNotMatch(md, /## Unknowns|## Reproduction/);
});

test('review findings list each finding with its location', () => {
  const md = renderFindingsMd(1, 'T', {
    verdict: 'approve', findings: [{ id: 'F-1', severity: 'minor', file: 'a.js', line: 9, what: 'w', why: 'y', fix: 'f' }],
  });
  assert.match(md, /Verdict: \*\*approve\*\*/);
  assert.match(md, /## F-1 \(minor\) — a\.js:9/);
});

test('the PDF page is a cover then one page per screenshot in order, captions escaped', () => {
  const html = demoPdfHtml({ iid: 1, title: 'T', issueUrl: ISSUE }, [
    { src: 'data:a', caption: 'shows <title>', file: 'a.png' },
    { src: 'data:b', caption: 'b', file: 'b.png', caseId: 'TC-2' },
  ]);
  assert.equal((html.match(/<section class="page/g) ?? []).length, 3);
  assert.ok(html.indexOf('data:a') < html.indexOf('data:b'));
  assert.match(html, /shows &lt;title&gt;/);
  assert.match(html, /2 \/ 2 · b\.png · TC-2/);
});

test('the service-account JWT is RS256-signed over the drive scope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = signJwt({
    client_email: 'sa@p.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }, 1000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
  assert.equal(claims.iss, 'sa@p.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url')));
});

test('a credential file is exchanged by its kind: refresh token, or signed service-account assertion', () => {
  const user = tokenRequest({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }, 1);
  assert.equal(user.get('grant_type'), 'refresh_token');
  assert.equal(user.get('refresh_token'), 'r');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = tokenRequest({ client_email: 'a@b', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, 1);
  assert.equal(sa.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.throws(() => tokenRequest({ type: 'authorized_user', client_id: 'c' }, 1), /missing a field/);
  assert.throws(() => tokenRequest({ foo: 1 }, 1), /neither/);
});

test('a person\'s sign-in asks only for drive.file, offline, with PKCE', () => {
  const u = new URL(consentUrl('cid', 'http://127.0.0.1:5555/', 'chal', 'st'));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/');
});
