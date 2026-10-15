import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iidFlag } from './cliargs.js';

const argv = (...rest: string[]): string[] => ['/usr/bin/node', 'src/index.ts', ...rest];

test('a well-formed --automation flag gives its iid', () => {
  assert.deepEqual(iidFlag(argv('--automation', '8420'), '--automation'), { given: true, iid: 8420 });
  assert.deepEqual(iidFlag(argv('--solo', '--automation', '8420'), '--automation'), { given: true, iid: 8420 });
});

test('no --automation flag is not given, so the conductor watches as usual', () => {
  assert.deepEqual(iidFlag(argv(), '--automation'), { given: false, iid: null });
  assert.deepEqual(iidFlag(argv('--ticket', '8420'), '--automation'), { given: false, iid: null });
});

test('a malformed --automation value is given without an iid, never read as no flag', () => {
  for (const rest of [
    ['--automation', '#8420'],
    ['--automation'],
    ['--automation', '--solo'],
    ['--automation', '0'],
    ['--automation', '-3'],
    ['--automation', '84.5'],
    ['--automation=8420'],
  ]) {
    assert.deepEqual(iidFlag(argv(...rest), '--automation'), { given: true, iid: null }, rest.join(' '));
  }
});
