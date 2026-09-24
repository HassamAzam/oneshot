/**
 * A documented example path must not be mistaken for a configured one.
 *
 * `ONESHOT_ERP_WORK_REPO=~/their/path/erp` was copied out of written setup
 * instructions and pasted as-is. `~` expanded, and the conductor reported a
 * missing checkout at /Users/<someone>/their/path/erp and advised cloning into
 * it — advice for a problem that did not exist, on a machine whose real
 * checkout was three directories away. The value looked like a path because it
 * was one; nothing about it said "still a blank".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholder } from './config.js';

test('stand-in paths are read as unfilled, not as locations', () => {
  for (const v of [
    '~/their/path/erp', '~/your/path/erp', '~/my/path/erp',
    '/path/to/erp', '~/path/to/the/repo', '~/some/path/erp',
  ]) assert.equal(isPlaceholder(v), true, `${v} should be treated as a placeholder`);
});

test('real checkout layouts are left alone', () => {
  // Every one of these is a layout somebody on the team actually uses. A false
  // positive here is worse than the bug: it would silently ignore a correct
  // setting and fall back to a path the machine does not have.
  for (const v of [
    '~/Documents/erp', '~/erp', '~/Desktop/workstream-repo/erp',
    '~/code/erp', '~/work/arbisoft/erp', '/Users/someone/repos/erp',
    '~/Documents/pathfinder/erp', '~/projects/mypath/erp',
  ]) assert.equal(isPlaceholder(v), false, `${v} is a real path and must be honoured`);
});

test('the original placeholder markers still work', () => {
  for (const v of ['REPLACE_ME', 'xoxb-REPLACE_ME', 'CHANGE_ME', 'your-token-here']) {
    assert.equal(isPlaceholder(v), true);
  }
  for (const v of ['', 'erp', 'arbisoft/erp', 'dev']) assert.equal(isPlaceholder(v), false);
});
