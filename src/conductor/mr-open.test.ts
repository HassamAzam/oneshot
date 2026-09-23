/**
 * The MR existing by the time a human is asked to approve anything.
 *
 * The gap this closes was an ordering one, so the tests are about ordering. The
 * test-case gate asks a person to approve scenarios; before `mr-open` the MR was
 * not opened until phase 8, so that person was asked to approve test cases for a
 * change they had no way to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phases, phaseByName } from '../lib/config.js';
import { CODE_PHASES } from './runner.js';

const nOf = (name: string): number => {
  const p = phaseByName(name);
  assert.ok(p, `phase ${name} is missing`);
  return p.n;
};

test('the MR is opened after the code exists and before the test-case gate', () => {
  // The whole point. Either inequality flipping puts a reviewer back in front of
  // a gate with nothing to read, or asks for an MR before there are commits.
  assert.ok(nOf('implement') < nOf('mr-open'), 'mr-open must follow implement');
  assert.ok(nOf('mr-open') < nOf('testcases'), 'mr-open must precede the testcases gate');
});

test('mr-open still precedes every phase that reads the case list', () => {
  // review, verify and ui-evidence all consume testcases.json, so the case list
  // cannot move after the MR — which is why the MR moved instead.
  for (const consumer of ['review', 'verify', 'ui-evidence']) {
    assert.ok(nOf('mr-open') < nOf(consumer), `mr-open must precede ${consumer}`);
    assert.ok(nOf('testcases') < nOf(consumer), `testcases must precede ${consumer}`);
  }
});

test('mr-open is deterministic and non-fatal', () => {
  const p = phaseByName('mr-open');
  assert.ok(p);
  // A model is not needed to push a branch and post an MR, and paying for one
  // would add tokens, latency and a way to get it wrong.
  assert.equal(p.kind, 'code');
  // An early MR is a convenience for the humans reading the gates. `mr` still
  // opens one at phase 8, so a failed courtesy push must not kill the run.
  assert.equal(p.onFail, 'warn');
  assert.ok(CODE_PHASES['mr-open'], 'mr-open must be registered as a code phase');
});

test('mr still runs, and last, so the draft is finished and undrafted', () => {
  // mr-open deliberately does NOT replace mr: it writes a placeholder body and
  // a Draft title, and mr owns the real description and taking the marker off.
  assert.ok(nOf('mr-open') < nOf('mr'));
  assert.ok(nOf('mr') < nOf('merge'), 'merge must not run before the draft is lifted');
});

test('every phase in the ordering is either implemented or a code phase', () => {
  // A phase present in config but wired to nothing is a silent no-op in the
  // sequence, which is exactly how mr-open could rot.
  const codes = new Set(Object.keys(CODE_PHASES));
  for (const p of phases().filter((x) => x.kind === 'code')) {
    assert.ok(codes.has(p.name), `code phase ${p.name} has no CODE_PHASES entry`);
  }
});
