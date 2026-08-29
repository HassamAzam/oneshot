/**
 * `npm run fleet:verify` — prove that concurrent conductors never take the same
 * ticket.
 *
 * A single-process test of the claim function proves the function. It does not
 * prove the SYSTEM, because the interesting failures live between processes:
 * two conductors reading the same rows in the same instant, SQLite serialising
 * their writes, one of them dying while holding a claim. So this spawns real
 * child processes against the real database and races them.
 *
 * Five properties are asserted, and each one corresponds to a way this has
 * actually gone wrong:
 *
 *   1. EXCLUSIVE   no ticket is claimed by two conductors.
 *   2. SATURATED   the fleet claims exactly the capacity it has. A design that
 *                  achieved exclusivity by refusing everything would pass (1)
 *                  and be useless; one that ignored the port pool would start
 *                  runs that cannot get a server.
 *   3. DISTRIBUTED more than one conductor ends up with work, which is the
 *                  whole point of starting more than one.
 *   4. NO THEFT    a conductor cannot resume a run another LIVE conductor owns.
 *                  This is the one a unique index cannot give you: a resume is
 *                  an UPDATE of an existing row, so the index never sees it.
 *   5. RECLAIMABLE a run owned by a DEAD conductor can be taken over, or a
 *                  crash would strand its ticket forever.
 *
 * The test writes rows for iids in a deliberately absurd range and removes them
 * afterwards, so it is safe to run against a live database while conductors are
 * working.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, activeRunsFleet, claimTicket, claimOwnership } from '../src/lib/db.js';
import { CONDUCTOR_TTL_MS } from '../src/lib/singleton.js';
import { portPool, projectConfig } from '../src/lib/config.js';

const SELF = fileURLToPath(import.meta.url);
const BASE_IID = 990000;
const TICKETS = 6;
const CONDUCTORS = 3;

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';
let failures = 0;
const ok = (l: string, d = '') => console.log(`  ${G}PASS${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`);
const bad = (l: string, d = '') => { failures += 1; console.log(`  ${R}FAIL${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); };

const iids = Array.from({ length: TICKETS }, (_, i) => BASE_IID + i);

function cleanup(): void {
  const list = iids.join(',');
  db.prepare(`DELETE FROM runs WHERE iid IN (${list})`).run();
  db.prepare("DELETE FROM conductors WHERE conductor_id LIKE 'fleettest-%'").run();
}

/**
 * A child conductor: register, try every ticket in the same order as its peers,
 * report, and then STAY ALIVE until the parent closes its stdin.
 *
 * Staying alive is not incidental to the test, it is the test. Liveness here is
 * conjunctive — the owning pid must exist AND its heartbeat must be fresh — so
 * a child that exits after claiming is correctly treated as dead and its ticket
 * is correctly reclaimable. An earlier version of this script exited, then
 * asserted that a peer could not resume the run, and reported a theft that was
 * really the reclaim path working exactly as designed. The owner has to still
 * be running for the question to mean anything.
 */
function child(id: string): void {
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO conductors (conductor_id, pid, started_at, heartbeat_at, argv) VALUES (?,?,?,?,?)',
  ).run(id, process.pid, now, now, 'fleet-verify');

  // The same two ceilings src/index.ts freeSlots() applies, because a child
  // that grabbed everything it could would prove exclusivity while telling you
  // nothing about how work actually spreads across a fleet.
  const perProcess = projectConfig().concurrency;
  const poolSize = portPool().length;

  const won: number[] = [];
  for (const iid of iids) {
    if (won.length >= perProcess) break;
    if (activeRunsFleet().length >= poolSize) break;
    if (claimTicket(iid, `run-${id}-${iid}`, 'fleet verification', id) === 'claimed') won.push(iid);
  }
  process.stdout.write(`${JSON.stringify({ id, won })}\n`);

  // Heartbeat like a real conductor while the parent runs its assertions.
  const beat = setInterval(() => {
    try {
      db.prepare('UPDATE conductors SET heartbeat_at = ? WHERE conductor_id = ?').run(Date.now(), id);
    } catch { /* the parent may have cleaned up already */ }
  }, 500);
  process.stdin.resume();
  process.stdin.on('end', () => { clearInterval(beat); process.exit(0); });
  process.stdin.on('close', () => { clearInterval(beat); process.exit(0); });
}

interface Child { id: string; won: number[]; kill: () => void }

/**
 * Start every conductor at once and resolve as each reports, WITHOUT waiting
 * for it to exit — the children are still running when the assertions begin,
 * which is what makes the live-owner cases testable.
 */
function race(): Promise<Child[]> {
  return Promise.all(
    Array.from({ length: CONDUCTORS }, (_, i) => new Promise<Child>((resolve) => {
      const id = `fleettest-${i}`;
      const p = spawn(process.execPath, [
        new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname, SELF, '--child', id,
      ], { stdio: ['pipe', 'pipe', 'inherit'] });
      const kill = (): void => { try { p.stdin.end(); p.kill(); } catch { /* already gone */ } };
      let out = '';
      p.stdout.on('data', (d) => {
        out += String(d);
        const line = out.trim().split('\n').pop() ?? '';
        try {
          const parsed = JSON.parse(line) as { id: string; won: number[] };
          resolve({ ...parsed, kill });
        } catch { /* not a complete line yet */ }
      });
      p.on('close', () => resolve({ id, won: [], kill }));
    })),
  );
}

async function main(): Promise<void> {
  console.log('\nOneshot fleet verification');
  console.log(`${D}  ${CONDUCTORS} conductors racing for ${TICKETS} tickets, real processes, one database${X}\n`);

  cleanup();
  const results = await race();

  console.log('Claims');
  for (const r of results) {
    console.log(`  ${D}${r.id}${X}  ${r.won.length ? r.won.map((i) => `#${i}`).join(' ') : '(none)'}`);
  }
  console.log();

  console.log('Properties');
  const all = results.flatMap((r) => r.won);
  const dupes = all.filter((v, i) => all.indexOf(v) !== i);
  dupes.length
    ? bad('EXCLUSIVE — a ticket was claimed twice', `#${[...new Set(dupes)].join(', #')}`)
    : ok('EXCLUSIVE — no ticket claimed by two conductors', `${all.length} claims`);

  // NOT "every ticket was claimed" — that would be a bug. The fleet is capped
  // by the port pool, so leaving tickets on the board once it is saturated is
  // the correct behaviour and the next tick picks them up as runs finish. What
  // must hold is that the fleet took exactly as much as it had capacity for:
  // fewer means work was dropped, more means a cap was ignored.
  const capacity = Math.min(iids.length, portPool().length);
  all.length === capacity
    ? ok('SATURATED — the fleet claimed exactly its capacity', `${all.length} of ${iids.length}, pool is ${portPool().length}`)
    : bad('SATURATED — claims did not match capacity', `claimed ${all.length}, capacity ${capacity}`);

  // The operator's actual question: do three sessions divide the work, or does
  // one take everything while the others idle?
  const workers = results.filter((r) => r.won.length).length;
  workers > 1
    ? ok('DISTRIBUTED — the work was split across conductors', `${workers} of ${CONDUCTORS} took tickets`)
    : bad('DISTRIBUTED — one conductor took everything', `${workers} conductor did all the work`);

  // A live owner's run must not be resumable by a peer.
  const held = results.find((r) => r.won.length)?.won[0];
  if (held === undefined) {
    bad('NO THEFT — could not test, nothing was claimed');
  } else {
    const owner = results.find((r) => r.won.includes(held))!;
    const thief = results.find((r) => r.id !== owner.id)!;

    // The owner is still running and still heartbeating at this point.
    claimOwnership(held, `run-${thief.id}-steal`, thief.id)
      ? bad('NO THEFT — a peer resumed a live conductor\'s run', `#${held}`)
      : ok('NO THEFT — a live conductor\'s run cannot be resumed by a peer', `#${held} held by ${owner.id}`);

    // Now stop the owner for real and let its heartbeat go cold. Exclusivity
    // that survives a crash is a stranded ticket, not a feature.
    owner.kill();
    await new Promise((r) => { setTimeout(r, 300); });
    db.prepare('UPDATE conductors SET heartbeat_at = ? WHERE conductor_id = ?')
      .run(Date.now() - CONDUCTOR_TTL_MS - 60_000, owner.id);
    claimOwnership(held, `run-${thief.id}-reclaim`, thief.id)
      ? ok('RECLAIMABLE — a dead conductor\'s run can be taken over', `#${held}`)
      : bad('RECLAIMABLE — a dead conductor\'s run is stranded', `#${held}`);
  }

  for (const r of results) r.kill();
  cleanup();
  console.log(`\n${failures ? R : G}${failures} failed${X}\n`);
  process.exit(failures ? 1 : 0);
}

if (process.argv.includes('--child')) {
  child(process.argv[process.argv.indexOf('--child') + 1] ?? 'fleettest-x');
} else {
  main().catch((err) => {
    console.error(`\nverification crashed: ${(err as Error).message}\n`);
    cleanup();
    process.exit(1);
  });
}
