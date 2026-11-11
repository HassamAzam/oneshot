/**
 * A finding is pinned to a diff line only where GitLab will accept it; anywhere
 * else it is posted on the MR as a whole rather than refused and lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLineFor, shownLines, type DiffFile } from './position.js';

const DIFF = [
  '@@ -10,6 +10,8 @@ class AdminTest(TestCase):',
  '     def setUp(self):',          // old 10, new 10
  '         self.client.login()',   // old 11, new 11
  '-        self.team = None',      // old 12
  '+        self.team = TeamFactory()',          // new 12
  '+        self.url = reverse("admin:teams")',  // new 13
  '+        self.extra = 1',                     // new 14
  ' ',                              // old 13, new 15
  '     def test_one(self):',       // old 14, new 16
  '\\ No newline at end of file',
  '@@ -40,3 +42,4 @@ def helper():',
  '     return 1',                  // old 40, new 42
  '+    # trailing',                // new 43
  ' ',                              // old 41, new 44
].join('\n');

const FILES: DiffFile[] = [
  { old_path: 'apps/teams/tests/admin_test.py', new_path: 'apps/teams/tests/admin_test.py', diff: DIFF },
  { old_path: 'templates/admin/old.html', new_path: 'templates/admin/base.html', diff: '@@ -1,2 +1,2 @@\n-<a>\n+<b>\n </html>' },
  { old_path: 'gone.py', new_path: 'gone.py', diff: '@@ -1 +0,0 @@\n-x', deleted_file: true },
];

test('an added line is placed by its new line number alone', () => {
  assert.deepEqual(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 13), {
    oldPath: 'apps/teams/tests/admin_test.py', newPath: 'apps/teams/tests/admin_test.py', newLine: 13,
  });
});

test('an unchanged line inside a hunk carries both numbers, which GitLab requires', () => {
  assert.deepEqual(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 16), {
    oldPath: 'apps/teams/tests/admin_test.py', newPath: 'apps/teams/tests/admin_test.py', newLine: 16, oldLine: 14,
  });
  // The second hunk keeps counting from its own header, not from the first.
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 44)?.oldLine, 41);
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 43)?.oldLine, undefined);
});

test('a line the diff does not show cannot be pinned', () => {
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 30), null, 'between the hunks');
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 611), null, 'far outside them');
  assert.equal(diffLineFor(FILES, 'apps/core/models.py', 87), null, 'a file the MR does not touch');
  assert.equal(diffLineFor(FILES, 'gone.py', 1), null, 'a deleted file has no new side');
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 0), null);
  assert.equal(diffLineFor(FILES, 'apps/teams/tests/admin_test.py', 12.5), null);
});

test('a renamed file is matched on its new path and positioned with both', () => {
  assert.deepEqual(diffLineFor(FILES, './templates/admin/base.html', 1), {
    oldPath: 'templates/admin/old.html', newPath: 'templates/admin/base.html', newLine: 1,
  });
  assert.equal(diffLineFor(FILES, 'templates/admin/old.html', 1), null);
});

test('a diff GitLab withheld shows no lines at all', () => {
  assert.equal(shownLines('').size, 0);
  assert.equal(diffLineFor([{ old_path: 'big.py', new_path: 'big.py', diff: '' }], 'big.py', 3), null);
});
