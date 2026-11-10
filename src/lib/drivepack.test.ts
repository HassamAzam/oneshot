import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  GOOGLE_DOC, GOOGLE_SHEET, INDEX_HEADER, demoPdfHtml, findIndexRow, indexRow, indexStatus, packEntries,
  renderFindingsMd, renderReadmeMd, renderResearchMd, sameRow, type IndexInput,
  ticketFolderName, type PackInput,
} from './drivepack.js';
import { codeFromPasted, consentUrl, signJwt, tokenRequest } from './gdrive.js';

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

test('a pasted-back sign-in yields its code only when it belongs to this attempt', () => {
  assert.equal(codeFromPasted('http://127.0.0.1:1/?state=st&code=4/abc&scope=x', 'st'), '4/abc');
  assert.equal(codeFromPasted('  4/abc  ', 'st'), '4/abc');
  assert.throws(() => codeFromPasted('http://127.0.0.1:1/?state=other&code=4/abc', 'st'), /different sign-in/);
  assert.throws(() => codeFromPasted('http://127.0.0.1:1/?state=st&error=access_denied', 'st'), /access_denied/);
  assert.throws(() => codeFromPasted('', 'st'), /nothing/);
});

const ROW_BASE: IndexInput = { iid: 9002, title: 'Page titles', issueUrl: ISSUE, phases: [], files: {} };

test('an index row links the ticket by its full issue URL with the iid as the text', () => {
  const row = indexRow({ ...ROW_BASE, phases: [] });
  assert.equal(row.length, INDEX_HEADER.length);
  assert.equal(row[0], `=HYPERLINK("${ISSUE}","9002")`);
  assert.equal(row[1], "'Page titles");
});

test('an index row links every artifact that exists, by the kind of Drive file it is', () => {
  const row = indexRow({
    ...ROW_BASE,
    files: { plan: { id: 'P' }, research: { id: 'R' }, testcases: { id: 'T' }, 'demo-pdf': { id: 'D' }, 'demo-video': { id: 'V' } },
    mrUrl: 'https://gitlab.arbisoft.com/arbisoft/erp/-/merge_requests/11237',
    folderUrl: 'https://drive.google.com/drive/folders/F',
  });
  const byCol = Object.fromEntries(INDEX_HEADER.map((h, i) => [h, row[i]]));
  assert.equal(byCol.Plan, '=HYPERLINK("https://docs.google.com/document/d/P/edit","Plan")');
  assert.equal(byCol.Research, '=HYPERLINK("https://docs.google.com/document/d/R/edit","Research")');
  assert.equal(byCol['Test cases'], '=HYPERLINK("https://docs.google.com/spreadsheets/d/T/edit","Test cases")');
  assert.equal(byCol['Demo PDF'], '=HYPERLINK("https://drive.google.com/file/d/D/view","Demo PDF")');
  assert.equal(byCol['Demo video'], '=HYPERLINK("https://drive.google.com/file/d/V/view","Demo video")');
  assert.match(byCol.MR!, /merge_requests\/11237","https:\/\/gitlab\.arbisoft\.com\/arbisoft\/erp\/-\/merge_requests\/11237"\)$/);
  assert.equal(byCol['Drive folder'], '=HYPERLINK("https://drive.google.com/drive/folders/F","Folder")');
});

test('a missing artifact leaves its cell empty rather than a dead link', () => {
  const row = indexRow({ ...ROW_BASE, files: { plan: { id: 'P' } } });
  assert.equal(row[INDEX_HEADER.indexOf('Research')], '');
  assert.equal(row[INDEX_HEADER.indexOf('MR')], '');
});

test('status reads as a person would say it, and the phase is where the run is or stopped', () => {
  assert.equal(indexStatus('done', 'abc'), 'merged');
  assert.equal(indexStatus('done'), 'done');
  assert.equal(indexStatus('parked'), 'on a gate');
  assert.equal(indexStatus('blocked'), 'blocked');
  assert.equal(indexStatus(undefined), 'running');
  const phases = [{ phase: 'plan', lap: 1, status: 'ok' as const, startedAt: 1, endedAt: Date.UTC(2026, 9, 29, 17, 59) }];
  const row = indexRow({ ...ROW_BASE, phases, status: 'running' });
  assert.equal(row[3], "'plan");
  assert.equal(row[4], "'2026-10-29 17:59 UTC");
  assert.equal(indexRow({ ...ROW_BASE, phases, stoppedPhase: 'merge' })[3], "'merge");
});

test('a title shaped like a formula is written as text, and quotes cannot break out of a link', () => {
  const row = indexRow({ ...ROW_BASE, title: '=IMPORTXML("http://evil")', issueUrl: 'https://g/x/-/issues/1"),("y' });
  assert.equal(row[1], `'=IMPORTXML("http://evil")`);
  assert.equal(row[0], '=HYPERLINK("https://g/x/-/issues/1""),(""y","9002")');
});

test('the upsert finds the ticket\'s row by its issue URL, not by the iid label', () => {
  const other = 'https://gitlab.arbisoft.com/arbisoft/other/-/issues/9002';
  const col = ['Ticket', `=HYPERLINK("${other}","9002")`, '=HYPERLINK("https://x/-/issues/8878","8878")', `=HYPERLINK("${ISSUE}","9002")`];
  assert.equal(findIndexRow(col, ISSUE), 4);
  assert.equal(findIndexRow(col, `${ISSUE}/`), 4);
  assert.equal(findIndexRow(col, 'https://x/-/issues/1'), null);
  assert.equal(findIndexRow(['Ticket', ISSUE], ISSUE), null, 'the header row and a bare value never match');
  const quoted = 'https://g/x/-/issues/1"),("y';
  assert.equal(findIndexRow(['Ticket', indexRow({ ...ROW_BASE, issueUrl: quoted })[0]!], quoted), 2);
});

test('a row read back as Sheets returns it compares equal to what was written', () => {
  const row = indexRow({ ...ROW_BASE, files: { plan: { id: 'P' } } });
  const readBack = row.map((c) => c.replace(/^'/, ''));
  while (readBack[readBack.length - 1] === '') readBack.pop();
  assert.ok(sameRow(readBack, row));
  assert.ok(!sameRow([...readBack.slice(0, 2), 'blocked'], row));
  assert.ok(!sameRow(undefined, row));
});
