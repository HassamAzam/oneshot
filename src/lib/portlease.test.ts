/**
 * A port belongs to a run only while the lease table says so.
 *
 * The journal keeps the port's NUMBER for the life of the run; `finish()`
 * releases the LEASE on every park and stop. Reading the journal alone, a
 * parked run re-entered on every tick reaped whatever was listening on its old
 * port — by then possibly another run's dev server — and a resumed run carried
 * on using a port it no longer owned. These pin the three things the fix rests
 * on: a run can ask what it holds, asking again does not take a second port,
 * and a resumed run gets its old port back only while nobody else has it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, db } from './db.js';
import { leasePortFor, portHeldBy, releasePort } from './worktrees.js';

/** Ports nothing on a developer machine or the server listens on, well away from every configured pool. */
const POOL = [47811, 47812];
const A = 'r-portlease-a';
const B = 'r-portlease-b';
const had = Object.prototype.hasOwnProperty.call(process.env, 'PORT_POOL');
const prior = process.env.PORT_POOL;

function wipe(): void {
  db.prepare('DELETE FROM port_leases WHERE run_id IN (?, ?)').run(A, B);
  db.prepare('DELETE FROM runs WHERE run_id IN (?, ?)').run(A, B);
}

before(() => {
  process.env.PORT_POOL = POOL.join(',');
  wipe();
  // A lease whose run is not claimed or running is reclaimed by the next lease,
  // so both runs need a live row for theirs to survive one another.
  createRun(A, 99900011, 'port lease a');
  createRun(B, 99900012, 'port lease b');
});

after(() => {
  wipe();
  if (had) process.env.PORT_POOL = prior;
  else delete process.env.PORT_POOL;
});

test('a run holds nothing until it leases, and can then say what it holds', () => {
  assert.equal(portHeldBy(A), null);
  assert.equal(leasePortFor(A), POOL[0]);
  assert.equal(portHeldBy(A), POOL[0]);
});

test('asking again returns the lease the run already has, not a second port', () => {
  assert.equal(leasePortFor(A), POOL[0]);
  assert.equal(leasePortFor(A, POOL[1]), POOL[0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM port_leases WHERE run_id = ?').get(A)
    && (db.prepare('SELECT COUNT(*) AS n FROM port_leases WHERE run_id = ?').get(A) as { n: number }).n, 1);
});

test('a released port is nobody\'s, whatever a journal still remembers', () => {
  releasePort(A);
  assert.equal(portHeldBy(A), null);
});

test('a resumed run gets its old port back only while no other run has taken it', () => {
  // B leased the port A parked on. A's journal still says POOL[0]; the table says B.
  assert.equal(leasePortFor(B), POOL[0]);
  assert.equal(leasePortFor(A, POOL[0]), POOL[1]);
  assert.equal(portHeldBy(B), POOL[0]);
  releasePort(A);
  releasePort(B);
  // With the port free again, the preference is honoured ahead of pool order.
  assert.equal(leasePortFor(A, POOL[1]), POOL[1]);
  releasePort(A);
});

test('a preferred port outside the pool is ignored rather than leased', () => {
  assert.equal(leasePortFor(A, 59999), POOL[0]);
  releasePort(A);
});
