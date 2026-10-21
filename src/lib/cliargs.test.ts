import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iidFlag, localTestsFlags, retiredFlagError } from './cliargs.js';

const argv = (...rest: string[]): string[] => ['/usr/bin/node', 'src/index.ts', ...rest];

test('a well-formed --local-tests flag gives its iid', () => {
  assert.deepEqual(iidFlag(argv('--local-tests', '8420'), '--local-tests'), { given: true, iid: 8420 });
  assert.deepEqual(iidFlag(argv('--solo', '--local-tests', '8420'), '--local-tests'), { given: true, iid: 8420 });
});

test('no --local-tests flag is not given, so the conductor watches as usual', () => {
  assert.deepEqual(iidFlag(argv(), '--local-tests'), { given: false, iid: null });
  assert.deepEqual(iidFlag(argv('--ticket', '8420'), '--local-tests'), { given: false, iid: null });
});

test('a malformed --local-tests value is given without an iid, never read as no flag', () => {
  for (const rest of [
    ['--local-tests', '#8420'],
    ['--local-tests'],
    ['--local-tests', '--solo'],
    ['--local-tests', '0'],
    ['--local-tests', '-3'],
    ['--local-tests', '84.5'],
    ['--local-tests=8420'],
  ]) {
    assert.deepEqual(iidFlag(argv(...rest), '--local-tests'), { given: true, iid: null }, rest.join(' '));
  }
});

test('--local-tests <iid> gives its iid, without --assume-label unless asked', () => {
  assert.deepEqual(localTestsFlags(argv('--local-tests', '990601'), false),
    { given: true, iid: 990601, assumeLabel: false, error: null });
  assert.deepEqual(localTestsFlags(argv(), false), { given: false, iid: null, assumeLabel: false, error: null });
});

test('--assume-label is accepted with DRY_RUN and --local-tests, in either order', () => {
  for (const rest of [['--local-tests', '990601', '--assume-label'], ['--assume-label', '--local-tests', '990601']]) {
    assert.deepEqual(localTestsFlags(argv(...rest), true), { given: true, iid: 990601, assumeLabel: true, error: null }, rest.join(' '));
  }
});

test('--assume-label is refused without DRY_RUN, so a real desk never posts on a ticket nobody labelled', () => {
  const r = localTestsFlags(argv('--local-tests', '990601', '--assume-label'), false);
  assert.equal(r.assumeLabel, true);
  assert.match(r.error ?? '', /only allowed with DRY_RUN=1/);
});

test('--assume-label alone, or with a value, is refused rather than ignored', () => {
  assert.match(localTestsFlags(argv('--assume-label'), true).error ?? '', /only goes with --local-tests/);
  assert.match(localTestsFlags(argv('--local-tests', '990601', '--assume-label=yes'), true).error ?? '', /takes no value/);
});

test('a malformed --local-tests value is refused, never read as no flag', () => {
  for (const rest of [['--local-tests'], ['--local-tests', '#990601'], ['--local-tests=990601'], ['--local-tests', '0']]) {
    const r = localTestsFlags(argv(...rest), true);
    assert.equal(r.given, true, rest.join(' '));
    assert.equal(r.iid, null, rest.join(' '));
    assert.match(r.error ?? '', /needs a positive ticket iid/, rest.join(' '));
  }
});

test('the retired --automation flag is refused, never read as no flag', () => {
  // Read as no flag, `npm start -- --automation 8420` from an old runbook would
  // boot a full watching conductor that claims Loop tickets.
  for (const rest of [['--automation', '8420'], ['--automation'], ['--automation=8420'], ['--solo', '--automation', '1']]) {
    assert.match(retiredFlagError(argv(...rest)) ?? '', /--automation was removed/, rest.join(' '));
  }
  assert.equal(retiredFlagError(argv('--local-tests', '8420')), null);
  assert.equal(retiredFlagError(argv()), null);
});
