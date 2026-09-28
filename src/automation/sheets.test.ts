/**
 * Sheets I/O against a stubbed fetch. The stub is a small fake of the Sheets
 * API that really applies each batchUpdate (inserts shift rows, marks and
 * merges; writes outside the grid are refused as Google refuses them), so the
 * read-back at the end of writeApprovedCases reads what the batches wrote, not
 * what a test pretended they wrote. Keys are generated per run; no real
 * credential or host is involved. Tickets are invented.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessToken, getValues, loadServiceAccount, retryAfterMs, signJwt, writeApprovedCases, SHEETS_SCOPE,
} from './sheets.js';
import { CASE_HEADERS, MARK_KEY, TRACKER_HEADERS, type SheetCase, type SheetConfig } from './sheetlayout.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const DIR = mkdtempSync(join(tmpdir(), 'oneshot-sheets-test-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

let files = 0;
/** A fresh key file per test: the token cache is per file, so tests never share a token. */
function saFile(extra: Record<string, unknown> = {}): string {
  const f = join(DIR, `sa-${++files}.json`);
  writeFileSync(f, JSON.stringify({ client_email: 'bot@example.iam.gserviceaccount.com', private_key: PEM, private_key_id: 'kid-1', ...extra }));
  return f;
}

// ------------------------------------------------------------------ the fake

interface FakeMerge { startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }
interface FakeTab { sheetId: number; title: string; index: number; hidden?: boolean; rowCount: number; columnCount: number; rows: string[][]; merges: FakeMerge[] }
interface FakeMark { value: string; sheetId: number; row: number }

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** Proto JSON: zero values are omitted, exactly as Google sends them. */
const noZeros = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== 0));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

class FakeGoogle {
  calls: string[] = [];
  batches: Array<{ tab: string; kinds: string[] }> = [];
  tokenBodies: string[] = [];
  marks: FakeMark[] = [];
  expiresIn = 3600;
  /** Answers a Sheets call before the fake does; return null to let it through. */
  intercept: ((url: string) => Response | null) | null = null;
  afterBatch: ((g: FakeGoogle) => void) | null = null;
  constructor(public tabs: FakeTab[]) {}

  tab(title: string): FakeTab {
    const t = this.tabs.find((x) => x.title === title);
    if (!t) throw new Error(`no tab ${title}`);
    return t;
  }

  async handle(url: string, init: RequestInit): Promise<Response> {
    if (url.includes('oauth2')) {
      this.calls.push('token');
      this.tokenBodies.push(String(init.body));
      return json({ access_token: `tok-${this.tokenBodies.length}`, expires_in: this.expiresIn, token_type: 'Bearer' });
    }
    const early = this.intercept?.(url) ?? null;
    if (early) { this.calls.push('intercepted'); return early; }
    const path = url.replace(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//, '');
    if (init.method === 'POST' && path.endsWith(':batchUpdate')) return this.batch(JSON.parse(String(init.body)).requests);
    if (init.method === 'POST' && path.endsWith('/developerMetadata:search')) return this.search(JSON.parse(String(init.body)));
    if (path.includes('/values/')) return this.values(decodeURIComponent(path.split('/values/')[1]!.split('?')[0]!));
    this.calls.push('get');
    return json({
      properties: { title: 'Fake sheet' },
      sheets: this.tabs.map((t) => ({
        properties: { ...noZeros({ sheetId: t.sheetId, index: t.index }), title: t.title, ...(t.hidden ? { hidden: true } : {}), gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount } },
        merges: t.merges.map((m) => noZeros({ sheetId: t.sheetId, ...m })),
      })),
    });
  }

  values(range: string): Response {
    this.calls.push(`values ${range}`);
    const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(range);
    if (!m) return json({ error: { code: 400, message: `Unable to parse range: ${range}` } }, 400);
    const t = this.tab(m[1]!.replace(/''/g, "'"));
    const r0 = Number(m[3]) - 1;
    const r1 = m[5] ? Number(m[5]) : t.rows.length;
    const c0 = colIndex(m[2]!);
    const c1 = m[4] ? colIndex(m[4]) + 1 : c0 + 1;
    const out = t.rows.slice(r0, r1).map((row) => {
      const cells = row.slice(c0, c1);
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      return cells;
    });
    while (out.length && out[out.length - 1]!.length === 0) out.pop();
    return json(out.length ? { range, majorDimension: 'ROWS', values: out } : { range, majorDimension: 'ROWS' });
  }

  search(body: { dataFilters: Array<{ developerMetadataLookup: { metadataKey: string; metadataValue: string } }> }): Response {
    this.calls.push('search');
    const wanted = new Set(body.dataFilters.filter((f) => f.developerMetadataLookup.metadataKey === MARK_KEY).map((f) => f.developerMetadataLookup.metadataValue));
    const hits = this.marks.filter((k) => wanted.has(k.value)).map((k) => ({
      developerMetadata: {
        metadataKey: MARK_KEY, metadataValue: k.value, visibility: 'DOCUMENT',
        location: { locationType: 'ROW', dimensionRange: { ...noZeros({ sheetId: k.sheetId, startIndex: k.row }), dimension: 'ROWS', endIndex: k.row + 1 } },
      },
    }));
    return json(hits.length ? { matchedDeveloperMetadata: hits } : {});
  }

  byId(sheetId: number): FakeTab {
    const t = this.tabs.find((x) => x.sheetId === sheetId);
    if (!t) throw new Error(`no sheet ${sheetId}`);
    return t;
  }

  /** Applies the batch to a copy and commits only if every request is valid: batchUpdate is atomic. */
  batch(requests: Array<Record<string, any>>): Response {
    const kinds = requests.map((r) => Object.keys(r)[0]!);
    const saved = JSON.stringify({ tabs: this.tabs, marks: this.marks });
    try {
      for (const r of requests) this.apply(r);
    } catch (err) {
      ({ tabs: this.tabs, marks: this.marks } = JSON.parse(saved));
      this.calls.push('batchUpdate (refused)');
      return json({ error: { code: 400, message: (err as Error).message } }, 400);
    }
    const first = requests[0]?.addSheet?.properties?.sheetId ?? Object.values(requests[0] ?? {})[0]?.range?.sheetId
      ?? Object.values(requests[0] ?? {})[0]?.start?.sheetId ?? Object.values(requests[0] ?? {})[0]?.sheetId;
    const tabTitle = this.tabs.find((t) => t.sheetId === first)?.title ?? '?';
    this.calls.push(`batchUpdate ${tabTitle}`);
    this.batches.push({ tab: tabTitle, kinds });
    this.afterBatch?.(this);
    return json({ spreadsheetId: 'x', replies: [] });
  }

  apply(r: Record<string, any>): void {
    if (r.addSheet) {
      const p = r.addSheet.properties;
      if (this.tabs.some((t) => t.sheetId === p.sheetId || t.title === p.title)) throw new Error('a sheet with that id or title exists');
      this.tabs.push({ sheetId: p.sheetId, title: p.title, index: this.tabs.length, rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount, rows: [], merges: [] });
    } else if (r.insertDimension) {
      const { sheetId, startIndex: s, endIndex: e } = r.insertDimension.range;
      const t = this.byId(sheetId);
      if (s >= t.rowCount) throw new Error(`insertDimension at ${s} is past the grid (${t.rowCount} rows)`);
      const n = e - s;
      while (t.rows.length < s) t.rows.push([]);
      t.rows.splice(s, 0, ...Array.from({ length: n }, () => []));
      t.rowCount += n;
      for (const k of this.marks) if (k.sheetId === sheetId && k.row >= s) k.row += n;
      for (const m of t.merges) {
        if (m.startRowIndex >= s) { m.startRowIndex += n; m.endRowIndex += n; } else if (m.endRowIndex > s) m.endRowIndex += n;
      }
    } else if (r.appendDimension) {
      const t = this.byId(r.appendDimension.sheetId);
      if (r.appendDimension.dimension === 'ROWS') t.rowCount += r.appendDimension.length; else t.columnCount += r.appendDimension.length;
    } else if (r.updateCells) {
      const { start, rows, fields } = r.updateCells;
      const t = this.byId(start.sheetId);
      rows.forEach((row: { values: Array<Record<string, any>> }, i: number) => row.values.forEach((cell, j) => {
        const ri = start.rowIndex + i;
        const ci = start.columnIndex + j;
        if (ri >= t.rowCount || ci >= t.columnCount) throw new Error(`Range (${t.title}!R${ri + 1}C${ci + 1}) exceeds grid limits`);
        if (!String(fields).startsWith('userEnteredValue')) return;
        while (t.rows.length <= ri) t.rows.push([]);
        const target = t.rows[ri]!;
        while (target.length <= ci) target.push('');
        const v = cell.userEnteredValue ?? {};
        target[ci] = v.stringValue ?? v.formulaValue ?? '';
      }));
    } else if (r.createDeveloperMetadata) {
      const md = r.createDeveloperMetadata.developerMetadata;
      const d = md.location.dimensionRange;
      if (d.endIndex - d.startIndex !== 1) throw new Error('developer metadata must sit on exactly one row');
      this.marks.push({ value: md.metadataValue, sheetId: d.sheetId, row: d.startIndex });
    } else if (r.mergeCells) {
      const { sheetId, ...m } = r.mergeCells.range;
      this.byId(sheetId).merges.push(m);
    } else if (r.unmergeCells) {
      const { sheetId, ...u } = r.unmergeCells.range;
      const t = this.byId(sheetId);
      t.merges = t.merges.filter((m) => !(m.startRowIndex >= u.startRowIndex && m.endRowIndex <= u.endRowIndex && m.startColumnIndex >= u.startColumnIndex && m.endColumnIndex <= u.endColumnIndex));
    } else if (!r.updateDimensionProperties) {
      throw new Error(`the fake does not know ${Object.keys(r)[0]}`);
    }
  }
}

let fake = new FakeGoogle([]);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => fake.handle(String(input), init ?? {})) as typeof fetch;

// ------------------------------------------------------------------ fixtures

const CFG: SheetConfig = { spreadsheetId: 'sheet-1', trackerTab: 'TestCases year {year}', moduleTabPrefix: 'TestCases_' };
const CASES: SheetCase[] = [
  { id: 'TC-01', scenario: 'Verify that a saved preference survives a reload', precondition: '', steps: ['Open the profile', 'Save'], expected: 'The preference is kept', automatable: 'yes', reason: 'Plain UI flow' },
  { id: 'TC-02', scenario: 'Verify that the export names the employee', precondition: 'Logged in as HR', steps: ['Export the PDF'], expected: 'The PDF names the employee', automatable: 'no', reason: 'PDF content cannot be read by Cypress' },
];
const INPUT = { iid: 101, title: 'Preferences do not "stick"', issueUrl: 'https://gitlab.example.com/acme/erp/-/issues/101', module: 'Profile', cases: CASES, year: 2026 };

/** The target sheet as it is today: one tracker tab, header on row 1 (trailing space), nothing else. */
function targetSheet(): FakeGoogle {
  return new FakeGoogle([{
    sheetId: 0, title: 'TestCases year 2026', index: 0, rowCount: 1000, columnCount: 26,
    rows: [['Modules', 'Ticket Updates', 'Test Case Status', 'Automation Status', 'Test Case Link ']], merges: [],
  }]);
}

// ------------------------------------------------------------------ auth

test('the JWT is RS256, verifies with the key, and asks for the sheets scope for one hour', () => {
  const sa = loadServiceAccount(saFile());
  const jwt = signJwt(sa, SHEETS_SCOPE, 1_700_000_000);
  const [h, p, sig] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), {
    iss: 'bot@example.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url'));

  // A key file's problems are named by file, never by showing the key.
  assert.throws(() => loadServiceAccount(join(DIR, 'missing.json')), /missing\.json \(ENOENT\)/);
  const broken = join(DIR, 'broken.json');
  writeFileSync(broken, `{"private_key": "${PEM.slice(0, 80)}`);
  assert.throws(() => loadServiceAccount(broken), (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes('BEGIN'));
  const nokey = saFile({ private_key: '' });
  assert.throws(() => loadServiceAccount(nokey), /has no private_key/);
});

test('the access token is fetched once and reused until it is near expiry', async () => {
  fake = targetSheet();
  const file = saFile();
  assert.equal((await getValues('sheet-1', "'TestCases year 2026'!A1:J", file)).ok, true);
  assert.equal((await getValues('sheet-1', "'TestCases year 2026'!A1:J", file)).ok, true);
  assert.equal(fake.tokenBodies.length, 1);
  const form = new URLSearchParams(fake.tokenBodies[0]);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion')?.split('.').length, 3);

  // A token within a minute of expiry is not used.
  fake = targetSheet();
  fake.expiresIn = 30;
  const short = saFile();
  await getValues('sheet-1', "'TestCases year 2026'!A1:J", short);
  await getValues('sheet-1', "'TestCases year 2026'!A1:J", short);
  assert.equal(fake.tokenBodies.length, 2);
  assert.deepEqual((await accessToken(join(DIR, 'nope.json'))), {
    ok: false, kind: 'auth', status: 0, error: `cannot read the Google service account file ${join(DIR, 'nope.json')} (ENOENT)`,
  });
});

test('a 401 drops the token and retries once', async () => {
  fake = targetSheet();
  let rejected = 0;
  fake.intercept = () => (rejected++ === 0 ? json({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, 401) : null);
  const res = await getValues('sheet-1', "'TestCases year 2026'!A1:J", saFile());
  assert.equal(res.ok, true);
  assert.deepEqual(fake.calls, ['token', 'intercepted', 'token', "values 'TestCases year 2026'!A1:J"]);

  // A token Google keeps refusing is auth, after exactly one retry.
  fake = targetSheet();
  fake.intercept = () => json({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, 401);
  const bad = await getValues('sheet-1', "'TestCases year 2026'!A1:J", saFile());
  assert.deepEqual(bad, { ok: false, kind: 'auth', status: 401, error: 'Request had invalid authentication credentials.' });
  assert.deepEqual(fake.calls, ['token', 'intercepted', 'token', 'intercepted']);
});

test('a 403 is permission and is not retried', async () => {
  fake = targetSheet();
  fake.intercept = () => json({ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, 403);
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: false });
  assert.deepEqual(res, { ok: false, kind: 'permission', status: 403, error: 'The caller does not have permission' });
  assert.deepEqual(fake.calls, ['token', 'intercepted']);
});

test('a 429 waits for Retry-After and retries twice, then reports server', async () => {
  fake = targetSheet();
  fake.intercept = () => json({ error: { code: 429, message: 'Quota exceeded' } }, 429, { 'Retry-After': '0.05' });
  const t0 = Date.now();
  const res = await getValues('sheet-1', "'TestCases year 2026'!A1:J", saFile());
  assert.deepEqual(res, { ok: false, kind: 'server', status: 429, error: 'Quota exceeded' });
  assert.deepEqual(fake.calls, ['token', 'intercepted', 'intercepted', 'intercepted']);
  assert.ok(Date.now() - t0 >= 90, 'both waits were honoured');
  assert.equal(retryAfterMs(null), 5_000);
  assert.equal(retryAfterMs('2'), 2_000);
  assert.equal(retryAfterMs('120'), 30_000);
  assert.equal(retryAfterMs('soon'), 5_000);
  // Unreachable is network, not a crash.
  fake = targetSheet();
  fake.intercept = () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await getValues('sheet-1', "'x'!A1", saFile()), { ok: false, kind: 'network', status: 0, error: 'fetch failed' });
});

// ------------------------------------------------------------------ writeApprovedCases

test('on the empty target sheet one approval creates TestCases_Profile, the Profile section, the row, the legend and the marks, then reads back', async () => {
  fake = targetSheet();
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: false });
  assert.ok(res.ok, JSON.stringify(res));
  const d = res.data;
  assert.deepEqual(fake.calls, [
    'token', 'get', 'search', "values 'TestCases year 2026'!A1:J",
    'batchUpdate TestCases_Profile', 'batchUpdate TestCases year 2026',
    "values 'TestCases_Profile'!A2:G4", "values 'TestCases year 2026'!A2:J2",
  ]);
  assert.deepEqual(fake.batches.map((b) => b.kinds), [
    ['addSheet', 'updateCells', ...Array(7).fill('updateDimensionProperties'), 'insertDimension', 'updateCells', 'mergeCells', 'updateCells', 'createDeveloperMetadata', 'createDeveloperMetadata'],
    ['insertDimension', 'updateCells', 'updateCells', 'updateCells', 'updateCells', 'updateCells', 'createDeveloperMetadata', 'updateCells', 'updateCells'],
  ]);
  const moduleTab = fake.tab('TestCases_Profile');
  assert.deepEqual(moduleTab.rows.slice(0, 4).map((r) => r.slice(0, 2)), [
    [...CASE_HEADERS].slice(0, 2), ['Ticket #101: Preferences do not "stick"'], ['TC-01', CASES[0]!.scenario], ['TC-02', CASES[1]!.scenario],
  ]);
  const tracker = fake.tab('TestCases year 2026');
  assert.equal(tracker.rows[1]![0], 'Profile');
  assert.equal(tracker.rows[1]![1], '=HYPERLINK("https://gitlab.example.com/acme/erp/-/issues/101","#101 Preferences do not ""stick""")');
  assert.deepEqual(tracker.rows[1]!.slice(2, 4), ['Done', 'Not started']);
  assert.equal(tracker.rows[1]![4], `=HYPERLINK("https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=${moduleTab.sheetId}&range=A2:G4","TestCases_Profile rows 2–4")`);
  assert.equal(tracker.rows[3]![0], 'Legends');
  assert.deepEqual(fake.marks.map((m) => [m.value, m.sheetId, m.row]), [
    ['block:101', moduleTab.sheetId, 1], ['block-end:101', moduleTab.sheetId, 3], ['tracker:101', 0, 1],
  ]);
  assert.deepEqual(d, {
    spreadsheetId: 'sheet-1',
    moduleTab: 'TestCases_Profile', moduleGid: moduleTab.sheetId, blockRange: 'A2:G4',
    blockLink: `https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=${moduleTab.sheetId}&range=A2:G4`,
    trackerTab: 'TestCases year 2026', trackerGid: 0, trackerRow: 2,
    trackerLink: 'https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0&range=A2:E2',
    automationStatus: 'Not started',
    created: { moduleTab: true, trackerTab: false, section: true, legend: true },
    alreadyThere: { block: false, trackerRow: false },
    dryRun: false,
  });
});

test('a second approval for the same ticket finds its marks and sends no batchUpdate', async () => {
  fake = targetSheet();
  const file = saFile();
  const first = await writeApprovedCases(INPUT, CFG, file, { dryRun: false });
  assert.ok(first.ok);
  fake.calls = [];
  const again = await writeApprovedCases(INPUT, CFG, file, { dryRun: false });
  assert.ok(again.ok, JSON.stringify(again));
  assert.ok(!fake.calls.some((c) => c.startsWith('batchUpdate')), fake.calls.join(', '));
  assert.deepEqual(fake.calls, ['get', 'search', "values 'TestCases year 2026'!A1:J", "values 'TestCases_Profile'!A2:G4", "values 'TestCases year 2026'!A2:J2"]);
  assert.deepEqual(again.data.alreadyThere, { block: true, trackerRow: true });
  assert.equal(again.data.blockRange, first.data.blockRange);
  assert.equal(again.data.trackerRow, first.data.trackerRow);
  // A person fixing a typo in a case since is not a read-back failure.
  fake.tab('TestCases_Profile').rows[2]![1] = 'Verify that a saved preference survives a page reload';
  assert.equal((await writeApprovedCases(INPUT, CFG, file, { dryRun: false })).ok, true);
});

test('a human block and a human tracker row for the same ticket do not stop oneshot writing its own', async () => {
  // The reference sheet's shape: a row 1 that is not about cases, the team's own block for this ticket with
  // its sub-header in C–E, and a tracker (header on row 2) whose Profile section already links the ticket.
  const teamModule = [
    ['Steps', 'Priority', 'PreCondition', 'Action', 'Description'],
    [],
    ['Ticket #101: Preferences (written by QA)'],
    ['', '', 'Test Scenario', 'Pre Condition', 'Steps'],
    ['', 'TC-1', 'Verify that the team case stays', 'none', '1. x'],
  ];
  const teamTracker = [
    ['Test Cases Updates 2026'],
    [...TRACKER_HEADERS],
    ['Profile', '=HYPERLINK("https://gitlab.example.com/acme/erp/-/work_items/101","#101")', 'Done', 'Not started', 'team link'],
    [], [],
    ['Payroll', 'x', 'Done', 'Not started', 'y'],
  ];
  fake = new FakeGoogle([
    { sheetId: 0, title: 'TestCases year 2026', index: 0, rowCount: 1000, columnCount: 26, rows: teamTracker.map((r) => [...r]), merges: [{ startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 }] },
    { sheetId: 555, title: 'TestCases_Profile', index: 1, rowCount: 1000, columnCount: 26, rows: teamModule.map((r) => [...r]), merges: [] },
  ]);
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: false });
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(res.data.alreadyThere, { block: false, trackerRow: false });
  // Our block goes under the team's: spacer row 6, banner 7, own sub-header 8 (B..H), cases 9–10.
  assert.equal(res.data.blockRange, 'A7:H10');
  const tab = fake.tab('TestCases_Profile');
  assert.deepEqual(tab.rows.slice(0, 5), teamModule, 'the team block is untouched');
  assert.equal(tab.rows[6]![0], 'Ticket #101: Preferences do not "stick"');
  assert.deepEqual(tab.rows[7]!.slice(1, 8), [...CASE_HEADERS]);
  assert.deepEqual(tab.rows[8]!.slice(1, 3), ['TC-01', CASES[0]!.scenario]);
  // The tracker row fills the section's free reserve row next to the team's row, which is untouched.
  assert.equal(res.data.trackerRow, 4);
  const tracker = fake.tab('TestCases year 2026');
  assert.deepEqual(tracker.rows[2], teamTracker[2]);
  assert.match(tracker.rows[3]![1]!, /issues\/101"/);
  assert.deepEqual(fake.marks.map((m) => m.value), ['block:101', 'block-end:101', 'tracker:101']);
  // An existing legend-less tracker gets the legend under its last row.
  assert.equal(tracker.rows[7]![0], 'Legends');
});

test('a tracker without a header row fails as layout, and nothing is written', async () => {
  fake = new FakeGoogle([{ sheetId: 0, title: 'TestCases year 2026', index: 0, rowCount: 1000, columnCount: 26, rows: [['Some notes'], ['Modules', 'Tickets']], merges: [] }]);
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: false });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.kind, 'layout');
  assert.match(!res.ok ? res.error : '', /tracker header row was not found in the first 10 rows of 'TestCases year 2026'/);
  assert.ok(!fake.calls.some((c) => c.startsWith('batchUpdate')), 'not even the module block');
  assert.equal(fake.tabs.length, 1);
});

test('a read-back mismatch fails as readback', async () => {
  fake = targetSheet();
  // Something (a person, a script) changes the block between the write and the read.
  fake.afterBatch = (g) => {
    const t = g.tabs.find((x) => x.title === 'TestCases_Profile');
    if (t?.rows[3]) t.rows[3]![0] = 'TC-99';
  };
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: false });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.kind, 'readback');
  assert.match(!res.ok ? res.error : '', /'TestCases_Profile' A2:G4: case row 2 should be TC-02/);
});

test('with dryRun the sheet is read, marks are searched, and no batchUpdate is ever posted', async () => {
  fake = targetSheet();
  const res = await writeApprovedCases(INPUT, CFG, saFile(), { dryRun: true });
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(fake.calls, ['token', 'get', 'search', "values 'TestCases year 2026'!A1:J"]);
  assert.equal(fake.tabs.length, 1);
  assert.equal(fake.marks.length, 0);
  assert.equal(res.data.dryRun, true);
  assert.equal(res.data.moduleTab, 'TestCases_Profile');
  assert.ok(res.data.moduleGid > 0, 'the planned gid stands in for a real one');
  assert.equal(res.data.blockRange, 'A2:G4');
  assert.equal(res.data.trackerRow, 2);
});

test('with dryRun a sink receives every unsent batch, module tab first, and still nothing is posted', async () => {
  fake = targetSheet();
  const kept: Array<{ tab: string; kinds: string[] }> = [];
  const res = await writeApprovedCases(INPUT, CFG, saFile(), {
    dryRun: true,
    dryRunSink: (tab, requests) => kept.push({ tab, kinds: requests.map((r) => Object.keys(r)[0] ?? '') }),
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(kept.map((k) => k.tab), ['TestCases_Profile', 'TestCases year 2026']);
  assert.ok(kept[0]!.kinds.includes('addSheet'), 'the new module tab is planned in the first batch');
  assert.ok(kept.every((k) => k.kinds.includes('createDeveloperMetadata')), 'each batch carries its ownership marks');
  assert.ok(!fake.calls.some((c) => c.startsWith('batchUpdate')));
});

test('a module that normalises to nothing is refused as layout before any read of the tabs\' content', async () => {
  fake = targetSheet();
  const res = await writeApprovedCases({ ...INPUT, module: '  ' }, CFG, saFile(), { dryRun: false });
  assert.equal(!res.ok && res.kind, 'layout');
  assert.ok(!fake.calls.some((c) => c.startsWith('batchUpdate')));
});
