import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileChangesOf, fileChangesSection, renderFileChanges } from './planfiles.js';

const fc = (path: string, action: string, area: string, what = 'x') => ({ path, action, area, what });

/** #8765's shape, trimmed: a data migration, backend helpers, new and edited React files. */
const plan = {
  steps: [
    { n: 1, what: 'seed', layer: 'migration', files: ['common/migrations/0020_add_limit.py'] },
    { n: 2, what: 'helper', layer: 'backend', files: ['apps/leaves/utils.py'] },
    { n: 3, what: 'bar', layer: 'frontend', files: ['frontend/src/leaves/components/QuotaBar.js'] },
  ],
  fileChanges: [
    fc('common/migrations/0020_add_limit.py', 'create', 'backend', 'Seed the employee Maternity LeaveLimit'),
    fc('apps/leaves/utils.py', 'modify', 'backend', 'Add `get_maternity_cycle_summary()`'),
    fc('frontend/src/leaves/components/QuotaBar.js', 'create', 'frontend', 'New quota bar component'),
    fc('apps/leaves/tests/maternity_leave_test.py', 'modify', 'backend', 'Cover the summariser'),
  ],
};

/** One row's cells, split the way GFM splits them: on pipes that are not backslash-escaped. */
function cells(md: string, marker: string): string[] {
  const rows = md.split('\n').filter((l) => l.startsWith('|') && l.includes(marker));
  assert.equal(rows.length, 1, `expected one row holding ${marker}, got ${rows.length}`);
  return rows[0]!.replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
}

test('files are grouped Frontend, then Backend, each under its own count', () => {
  const md = fileChangesSection(plan);
  const fe = md.indexOf('**Frontend** — 1 file\n\n| | File | Change |');
  const be = md.indexOf('**Backend** — 3 files\n\n| | File | Change |');
  assert.ok(fe >= 0 && be > fe, md);
  assert.ok(md.indexOf('QuotaBar.js') < be, 'a frontend file sits in the Frontend table');
  assert.ok(md.indexOf('utils.py') > be, 'a backend file sits in the Backend table');
});

test('Config appears only when a change needs it', () => {
  assert.doesNotMatch(fileChangesSection(plan), /\*\*Config\*\*/);
  const md = fileChangesSection({
    fileChanges: [...plan.fileChanges, fc('hrdb/settings.py', 'modify', 'config', 'Read `MATERNITY_DAYS` from the env')],
  });
  assert.match(md, /\*\*Config\*\* — 1 file\n\n\| \| File \| Change \|/);
  assert.ok(md.indexOf('**Config**') > md.indexOf('**Backend**'), 'Config comes last');
});

test('the count line totals new, modified and deleted, and leaves out a zero count', () => {
  assert.match(fileChangesSection(plan), /^4 files · 🆕 2 new · ✏️ 2 modified\n/);
  const md = fileChangesSection({ fileChanges: [fc('a.js', 'delete', 'frontend')] });
  assert.match(md, /^1 file · 🗑️ 1 deleted\n/);
});

test('each row leads with its action, so new and edited files are told apart at a glance', () => {
  const md = fileChangesSection(plan);
  assert.equal(cells(md, 'QuotaBar.js')[0]!.trim(), '🆕');
  assert.equal(cells(md, 'utils.py')[0]!.trim(), '✏️');
});

test('the file name leads in bold and its directory sits underneath, so the path stays whole', () => {
  const md = fileChangesSection(plan);
  assert.match(md, /\| \*\*`utils\.py`\*\*<br><sub>`apps\/leaves\/`<\/sub> \| Add `get_maternity_cycle_summary\(\)` \|/);
  const root = fileChangesSection({ fileChanges: [fc('package.json', 'modify', 'config', 'Bump mermaid')] });
  assert.match(root, /\| \*\*`package\.json`\*\* \| Bump mermaid \|/, 'a root file has no directory line');
});

test('a test or a migration is tagged from its path, and the key names only the tags present', () => {
  const md = fileChangesSection(plan);
  assert.match(md, /\*\*`maternity_leave_test\.py`\*\* 🧪/);
  assert.match(md, /\*\*`0020_add_limit\.py`\*\* 🗄️/);
  assert.match(md, /<sub>🧪 test · 🗄️ migration<\/sub>$/);
  const plain = fileChangesSection({ fileChanges: [fc('frontend/src/a.js', 'modify', 'frontend')] });
  assert.doesNotMatch(plain, /🧪|🗄️/);
  for (const p of ['frontend/src/__tests__/a.test.js', 'apps/x/test_utils.py', 'common/tests.py', 'src/a.spec.ts']) {
    assert.match(fileChangesSection({ fileChanges: [fc(p, 'create', 'backend')] }), /🧪/, p);
  }
  for (const p of ['apps/x/contest.py', 'frontend/src/latest.js', 'apps/attestation/views.py']) {
    assert.doesNotMatch(fileChangesSection({ fileChanges: [fc(p, 'create', 'backend')] }), /🧪/, p);
  }
});

test('a pipe in a path or a description cannot add a column, and a newline cannot end the table', () => {
  const md = fileChangesSection({
    fileChanges: [fc('apps/a|b.py', 'modify', 'backend', 'Save | Cancel\nsecond line')],
  });
  assert.equal(cells(md, 'Save').length, 3);
  assert.match(md, /Save \\\| Cancel<br>second line \|$/m);
});

test('HTML in a description is escaped, and an empty one shows a dash', () => {
  const md = fileChangesSection({
    fileChanges: [fc('a.js', 'modify', 'frontend', 'Add a <main> landmark'), fc('b.js', 'modify', 'frontend', '')],
  });
  assert.match(md, /Add a &lt;main&gt; landmark \|/);
  assert.equal(cells(md, 'b.js')[2]!.trim(), '—');
});

test('a file the steps name but the table leaves out is reported, not invented', () => {
  const md = fileChangesSection({
    ...plan,
    steps: [...plan.steps, { n: 4, what: 'x', layer: 'frontend', files: ['frontend/src/Missing.js'] }],
  });
  assert.match(md, /⚠️ Named in the steps but missing from these tables: `frontend\/src\/Missing\.js`/);
  assert.doesNotMatch(md, /\| .*Missing\.js/, 'no row is made up for it');
  assert.doesNotMatch(fileChangesSection(plan), /Named in the steps/);
});

test('a bad entry is dropped with a warning: no path, an unknown action or area, a repeated path', () => {
  const r = renderFileChanges({
    fileChanges: [
      fc('', 'create', 'backend'),
      fc('a.py', 'rename', 'backend'),
      fc('b.py', 'modify', 'database'),
      fc('c.py', 'modify', 'backend', 'first'),
      fc('c.py', 'delete', 'backend', 'second'),
      'not an object',
    ],
  });
  assert.deepEqual(r.changes.map((c) => `${c.path}:${c.what}`), ['c.py:first']);
  assert.equal(r.warnings.length, 5);
});

test('a plan without fileChanges — written before the field existed — renders nothing', () => {
  assert.equal(fileChangesSection({ steps: plan.steps }), '');
  assert.equal(fileChangesSection(null), '');
  assert.equal(fileChangesSection({ fileChanges: 'nope' }), '');
  assert.deepEqual(fileChangesOf({ fileChanges: [] }, []), []);
});
