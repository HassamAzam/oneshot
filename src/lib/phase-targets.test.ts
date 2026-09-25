/**
 * A phase that belongs to one target must not land on everyone else.
 *
 * `mr-open` changes the SHAPE of the pipeline: it opens the MR before the
 * gates instead of after them, and a run that aborts between it and `mr` now
 * leaves a draft MR behind where it previously left none. That was asked for
 * while moving to the erp target — so an unscoped version of it would have
 * changed the pipeline for every conductor on every project the moment it
 * pulled, which is a cost nobody else agreed to pay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VAR = 'ONESHOT_PROJECT';

/** See target.test.ts: the empty string, never `delete` — dotenv fills a missing key. */
async function phasesWith(value: string): Promise<Array<{ name: string; targets?: string[] }>> {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const before = process.env[VAR];
  process.env[VAR] = value;
  try {
    const m = await import(`./config.js?phases=${encodeURIComponent(value)}-${Date.now()}`);
    return (m.phases as () => Array<{ name: string; targets?: string[] }>)();
  } finally {
    if (had) process.env[VAR] = before;
    else delete process.env[VAR];
  }
}

test('no target selected runs the pipeline without mr-open', async () => {
  const names = (await phasesWith('')).map((p) => p.name);
  assert.ok(!names.includes('mr-open'), `mr-open leaked into the default pipeline: ${names.join(', ')}`);
  // The phases either side of it are untouched, so the sequence everyone else
  // runs is the one they ran before mr-open existed.
  assert.equal(names[names.indexOf('implement') + 1], 'testcases');
});

test('the erp target runs mr-open between implement and testcases', async () => {
  const names = (await phasesWith('erp')).map((p) => p.name);
  assert.equal(names[names.indexOf('implement') + 1], 'mr-open');
  assert.equal(names[names.indexOf('mr-open') + 1], 'testcases');
});

test('adding the target gate adds exactly one phase and removes none', async () => {
  const off = (await phasesWith('')).map((p) => p.name);
  const on = (await phasesWith('erp')).map((p) => p.name);
  assert.deepEqual(on.filter((n) => !off.includes(n)), ['mr-open']);
  assert.deepEqual(off.filter((n) => !on.includes(n)), []);
});

test('an untargeted phase runs under every target', async () => {
  // The guarantee that makes the field safe to add: absent `targets` is not
  // "belongs to no one", it is "belongs to everyone".
  for (const value of ['', 'erp']) {
    const list = await phasesWith(value);
    const untargeted = list.filter((p) => !p.targets).map((p) => p.name);
    for (const core of ['research', 'plan', 'implement', 'testcases', 'mr', 'merge']) {
      assert.ok(untargeted.includes(core), `${core} missing with ONESHOT_PROJECT='${value}'`);
    }
  }
});
