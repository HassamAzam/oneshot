/**
 * `npm run unblock <iid>` — hand a blocked run back to the conductor.
 *
 * A block is a request for a human, and answering one turned out to be six
 * fiddly edits performed in the right order: prune the failed phase records out
 * of state/runs/<iid>/run.json, clear status/blockedWhy/blockedAt, delete the
 * half-written artifact the failed lap left on disk, drop the quota rows that
 * lap already spent, put the entry label back on the ticket, and let go of the
 * port lease the dead run is still holding. Each one is mechanical;
 * doing them by hand is how a journal ends up describing a run that never
 * happened, and how a ticket ends up carrying neither the entry label nor the
 * blocked one and therefore never being looked at again by anything.
 *
 * Two rules shape the whole file.
 *
 * A SUCCEEDED record is never touched. The journal is what makes a resume cheap
 * — phases that already returned ok/warned/skipped are skipped rather than
 * re-paid for — so a retry that wipes the history costs far more than the block
 * did, and re-runs an Opus implement lap to arrive back where it started.
 *
 * An artifact is deleted only when its phase has NO surviving success. A stale
 * artifact from a failed attempt is worse than no artifact at all, because the
 * next lap reads it as fact and plans against work that was never finished. But
 * a phase that failed once and succeeded on the next lap has an artifact that
 * belongs to the SUCCESS, and deleting it would blind every downstream phase
 * that reads `prior[name]`.
 *
 * Everything here is idempotent: a second run finds nothing left to prune, no
 * artifact to delete and the entry label already in place, and says so.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  phaseByName, projectConfig, runDir,
} from '../src/lib/config.js';
import {
  readJournal, writeJournal, type PhaseRecord, type RunJournal,
} from '../src/lib/artifacts.js';
import { db, logEvent, updateRun } from '../src/lib/db.js';
import { liveConductorIds } from '../src/lib/fleet.js';
import { getIssue, swapLabel } from '../src/lib/gitlab.js';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

/**
 * Statuses a record may carry and still be worth keeping.
 *
 * 'skipped' is in here with the successes on purpose: it is what the conductor
 * writes for a phase that was deliberately not run (ONESHOT_SKIP_DEPLOY, an
 * onFail:'skip' failure it chose to walk past). Dropping those would make a
 * retry re-enter phases the run had already decided against.
 */
const KEPT_STATUSES = new Set<PhaseRecord['status']>(['ok', 'warned', 'skipped']);

interface Args { iid: number; phase?: string; dryRun: boolean }

function parseArgs(argv: string[]): Args | string {
  let iid = 0;
  let phase: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--dry-run' || a === '-n') { dryRun = true; continue; }
    if (a === '--phase') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) return '--phase needs a phase name';
      phase = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--phase=')) {
      phase = a.slice('--phase='.length);
      if (!phase) return '--phase needs a phase name';
      continue;
    }
    if (/^#?\d+$/.test(a)) { iid = Number(a.replace('#', '')); continue; }
    return `unrecognised argument '${a}'`;
  }

  if (!iid) return 'no ticket iid given';
  return { iid, phase, dryRun };
}

function usage(): void {
  console.log(`
${B}npm run unblock -- <iid> [--phase <name>] [--dry-run]${X}

  ${D}Drops the failed phase records from a blocked run's journal, deletes the
  artifacts those laps half-wrote, refunds their phase quota, and puts the
  entry label back so the watcher picks the ticket up again.${X}

  --phase <name>   prune only this phase's failed records
  --dry-run        print every change and make none
`);
}

// -------------------------------------------------------------- the conductor

interface RunRowLite { run_id: string; status: string; phase: string | null; owner: string | null }

function inFlightRows(iid: number): RunRowLite[] {
  return db.prepare(
    `SELECT run_id, status, phase, owner FROM runs
     WHERE iid = ? AND status IN ('claimed','running')`,
  ).all(iid) as RunRowLite[];
}

/**
 * Rows for THIS ticket that a conductor still standing is actually driving.
 *
 * The question is ownership, not existence. "Is any conductor running?" was the
 * right question while there could only be one; with a fleet it refuses to
 * unblock #123 because somebody three terminals away is mid-QA on #456, and the
 * two have nothing to do with each other. Equally, a claimed/running row whose
 * owner is gone is precisely the residue this script exists to clear — it is
 * what keeps the watcher skipping the ticket forever.
 */
function liveOwners(rows: RunRowLite[]): RunRowLite[] {
  const live = new Set(liveConductorIds());
  return rows.filter((r) => r.owner !== null && live.has(r.owner));
}

// ------------------------------------------------------------- the summaries

interface PhaseLine { phase: string; statuses: PhaseRecord['status'][]; dropping: number }

function summarise(j: RunJournal, doomed: Set<PhaseRecord>): PhaseLine[] {
  const order: string[] = [];
  const byPhase = new Map<string, PhaseLine>();
  for (const rec of j.phases) {
    let line = byPhase.get(rec.phase);
    if (!line) {
      line = { phase: rec.phase, statuses: [], dropping: 0 };
      byPhase.set(rec.phase, line);
      order.push(rec.phase);
    }
    line.statuses.push(rec.status);
    if (doomed.has(rec)) line.dropping += 1;
  }
  return order.map((name) => byPhase.get(name)!);
}

function paintStatus(s: PhaseRecord['status']): string {
  if (s === 'ok') return `${G}ok${X}`;
  if (s === 'warned' || s === 'skipped') return `${Y}${s}${X}`;
  return `${R}${s}${X}`;
}

function printJournal(title: string, j: RunJournal, doomed = new Set<PhaseRecord>()): void {
  console.log(`\n${B}${title}${X}`);
  console.log(`  run       ${j.runId}   ${D}${j.title}${X}`);
  console.log(`  status    ${j.status === 'blocked' ? `${R}blocked${X}` : j.status}`);
  if (j.blockedWhy) console.log(`  blocked   ${R}${j.blockedWhy}${X}`);
  if (j.blockedAt) console.log(`  since     ${new Date(j.blockedAt).toLocaleString()}`);

  const lines = summarise(j, doomed);
  if (!lines.length) {
    console.log(`  ${D}no phase records${X}`);
    return;
  }
  console.log(`  ${D}phases${X}`);
  for (const line of lines) {
    const drop = line.dropping ? `   ${R}drop ${line.dropping}${X}` : '';
    console.log(`    ${line.phase.padEnd(12)} ${line.statuses.map(paintStatus).join(', ')}${drop}`);
  }
}

// ------------------------------------------------------------------ the work

/**
 * Files a retried phase must not leave behind.
 *
 * Both shapes the pipeline writes: the phase's own artifact (whose name comes
 * from phases.json, not from the phase name — `review` writes findings.json)
 * and the `<phase>-partial.json` that verify and qa rewrite after every test
 * case. The partial exists so a session that dies at its turn cap can still be
 * salvaged; carried into a fresh lap it would salvage results the new lap never
 * produced.
 */
function artifactsOf(iid: number, phase: string): string[] {
  const configured = phaseByName(phase)?.artifact ?? `${phase}.json`;
  return [configured, `${phase}-partial.json`]
    .map((name) => join(runDir(iid), name))
    .filter((p) => existsSync(p));
}

function quotaRowsFor(runId: string, phases: string[]): { n: number; weighted: number } {
  if (!phases.length) return { n: 0, weighted: 0 };
  const holes = phases.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(weighted), 0) AS weighted
     FROM quota_usage WHERE run_id = ? AND phase IN (${holes})`,
  ).get(runId, ...phases) as { n: number; weighted: number };
  return row;
}

function portLeasesFor(runId: string): number[] {
  try {
    return (db.prepare('SELECT port FROM port_leases WHERE run_id = ?').all(runId) as Array<{ port: number }>)
      .map((r) => r.port);
  } catch {
    // The table is created lazily by the first port lease ever taken.
    return [];
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.log(`\n${R}${parsed}${X}`);
    usage();
    process.exit(1);
  }
  const { iid, phase: only, dryRun } = parsed;

  const journal = readJournal(iid);
  if (!journal) {
    console.log(`\n${Y}#${iid} has no run journal${X} ${D}(${join(runDir(iid), 'run.json')})${X}`);
    console.log(`${D}Nothing to unblock — this ticket has never been run.${X}\n`);
    process.exit(0);
  }

  const doomed = new Set(
    journal.phases.filter(
      (rec) => !KEPT_STATUSES.has(rec.status) && (only === undefined || rec.phase === only),
    ),
  );

  console.log(dryRun ? `\n${Y}unblock #${iid} — DRY RUN, nothing will change${X}` : `\nunblock #${iid}`);
  printJournal('BEFORE', journal, doomed);

  // A DELIVERED run is not a blocked one, and forcing it back to 'running'
  // would do real damage: decideResume() archives a completed journal and cuts
  // a new run id, and it can only recognise one by its 'done' status. Rewrite
  // that and the ticket instead RESUMES a run that already shipped — every
  // phase reads as succeeded, so it walks straight to close with no work done.
  // The re-run path is the label, and it already works.
  if (journal.status === 'done') {
    console.log(`\n${Y}#${iid}'s run finished — there is nothing blocked here.${X}`);
    console.log(
      `${D}To run the ticket again, put "${projectConfig().labels.entry}" back on it: the ` +
      'conductor archives this journal and starts a fresh run rather than resuming a ' +
      `delivered one.${X}\n`,
    );
    process.exit(0);
  }

  // Checked after the summary and before the first write: the operator gets the
  // state they asked about either way, and a refusal explains itself against
  // something they can already see. The runs table is the signal because it is
  // the same one the conductor's own claim reads (src/lib/db.ts claimOwnership)
  // — editing a journal under a live run is how it gets corrupted.
  const inFlight = inFlightRows(iid);
  const driven = liveOwners(inFlight);
  if (driven.length) {
    const who = [...new Set(driven.map((r) => r.owner!))].map((o) => o.slice(0, 6)).join(', ');
    console.log(
      `\n${R}refusing${X} — conductor ${who} is alive and owns #${iid} ` +
      `${D}(${driven.map((r) => `${r.run_id}:${r.phase ?? r.status}`).join(', ')})${X}`,
    );
    console.log(`${D}Stop that one, or wait for the run to reach a terminal status:${X}`);
    console.log('  pkill -f "src/index.ts"\n');
    process.exit(1);
  }

  const retried = [...new Set([...doomed].map((rec) => rec.phase))].sort();
  const survivors = journal.phases.filter((rec) => !doomed.has(rec));
  const stillSucceeds = new Set(
    survivors.filter((rec) => rec.status === 'ok' || rec.status === 'warned').map((r) => r.phase),
  );
  const files = retried
    .filter((p) => !stillSucceeds.has(p))
    .flatMap((p) => artifactsOf(iid, p));
  const quota = quotaRowsFor(journal.runId, retried);
  const leases = portLeasesFor(journal.runId);
  const orphaned = [...new Set(inFlight.map((r) => r.owner).filter(Boolean))] as string[];

  console.log(`\n${B}PLAN${X}`);
  if (only !== undefined) console.log(`  ${D}scoped to --phase ${only}${X}`);
  console.log(`  records   ${doomed.size ? `drop ${doomed.size} of ${journal.phases.length} (${retried.join(', ')})` : `${D}none to drop${X}`}`);
  for (const p of retried.filter((x) => stillSucceeds.has(x))) {
    console.log(`  ${D}keeping ${p}'s artifact — a later lap of it succeeded${X}`);
  }
  console.log(`  artifacts ${files.length ? files.map((f) => f.replace(`${runDir(iid)}/`, '')).join(', ') : `${D}none to delete${X}`}`);
  console.log(`  quota     ${quota.n ? `${quota.n} row(s), ${(quota.weighted / 1e6).toFixed(2)}M weighted, refunded` : `${D}nothing spent on those phases${X}`}`);
  console.log(`  status    ${journal.status} -> running${journal.blockedWhy ? ', blockedWhy/blockedAt cleared' : ''}`);
  console.log(`  leases    ${leases.length ? `release port ${leases.join(', ')}` : `${D}no port held${X}`}`);
  console.log(`  runs row  ${inFlight.length ? `${inFlight.length} orphaned ${inFlight.map((r) => r.status).join('/')} row(s) -> aborted` : `${D}clean${X}`}`);
  console.log(`  owner     ${orphaned.length ? `${orphaned.map((o) => o.slice(0, 6)).join(', ')} ${D}— no longer in the fleet${X}` : `${D}unowned${X}`}`);

  const cfg = projectConfig();
  const issue = await getIssue(iid);
  if (issue.ok && issue.data) {
    const labels = issue.data.labels;
    const wanted = labels.filter((l) => l !== cfg.labels.blocked);
    if (!wanted.includes(cfg.labels.entry)) wanted.push(cfg.labels.entry);
    const same = wanted.length === labels.length && wanted.every((l) => labels.includes(l));
    console.log(`  labels    ${same ? `${D}already ${labels.join(', ')}${X}` : `${labels.join(', ')} -> ${wanted.join(', ')}`}`);
  } else {
    console.log(`  labels    ${Y}could not read #${iid} from GitLab (${issue.kind} ${issue.status}) — will still try the swap${X}`);
  }

  if (dryRun) {
    console.log(`\n${Y}dry run — nothing was changed.${X}`);
    console.log(`${D}Run it for real:  npm run unblock -- ${iid}${only ? ` --phase ${only}` : ''}${X}\n`);
    process.exit(0);
  }

  // Journal first. It is the only piece of this that a resumed run reads for
  // control flow, so if anything below fails the ticket is still resumable.
  journal.phases = survivors;
  journal.status = 'running';
  delete journal.blockedWhy;
  delete journal.blockedAt;
  writeJournal(journal);

  for (const f of files) rmSync(f, { force: true });

  if (retried.length) {
    const holes = retried.map(() => '?').join(', ');
    db.prepare(`DELETE FROM quota_usage WHERE run_id = ? AND phase IN (${holes})`)
      .run(journal.runId, ...retried);
  }

  try {
    db.prepare('DELETE FROM port_leases WHERE run_id = ?').run(journal.runId);
  } catch { /* the table is created by the first lease ever taken */ }

  // Buried the same way boot-time reconciliation buries them: 'aborted' is a
  // RESUMABLE status, and leaving the row claimed/running would keep the
  // watcher skipping this ticket ("run already in flight") no matter how many
  // times the entry label goes back on it.
  for (const row of inFlight) {
    updateRun(row.run_id, { status: 'aborted', ended_at: Date.now() });
  }

  const swapped = await swapLabel(iid, [cfg.labels.blocked], [cfg.labels.entry]);
  if (!swapped.ok) {
    console.log(
      `\n${R}the label swap failed${X} ${D}(${swapped.kind} ${swapped.status})${X} — ` +
      `the journal is unblocked, but #${iid} still needs "${cfg.labels.entry}" put back by hand.`,
    );
  }

  logEvent('unblocked', {
    iid, phases: retried, records: doomed.size, artifacts: files.length,
    quotaRows: quota.n, ports: leases, orphanedOwners: orphaned,
  }, { runId: journal.runId });

  printJournal('AFTER', readJournal(iid) ?? journal);

  console.log(`\n${G}#${iid} is claimable again.${X}`);
  console.log(`  ${B}npm start -- --ticket ${iid}${X}   ${D}run it now${X}`);
  // Only offered when the label actually moved. The watcher finds work by the
  // entry label and nothing else, so promising it will come round on its own
  // after a failed swap is the one piece of advice that leaves the ticket sitting.
  if (swapped.ok) {
    console.log(`  ${D}or leave the watcher up — the entry label is back on the ticket.${X}\n`);
  } else {
    console.log(`  ${D}the watcher will not find it until "${cfg.labels.entry}" is on the ticket.${X}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${R}unblock failed${X}: ${(err as Error).message}\n`);
  process.exit(1);
});
