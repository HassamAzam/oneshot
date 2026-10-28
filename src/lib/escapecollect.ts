/**
 * Sweep the tickets Oneshot has shipped and record what QA found afterwards.
 *
 * WHY A SWEEP AND NOT A PHASE. The window this measures — merge to QA sign-off
 * — outlives the run that opened it. `merge` is the last phase, the run ends
 * there, and erp#8781 was signed off two days later. A run cannot watch itself
 * after it has finished, so the watching has to be something that re-reads every
 * shipped ticket. That costs nothing to repeat: the label history lives in
 * GitLab permanently, so a desk that was switched off for a weekend sees
 * everything it missed on the next sweep.
 *
 * THE COHORT COMES FROM THE JOURNALS, NOT THE BOARD. A shipped ticket is one
 * whose run recorded a `mergedSha` — the pipeline's own record that it landed.
 * Taking the cohort from the `Merged` label instead would drop any ticket whose
 * board column was never moved, and a dropped ticket is as likely to be one that
 * escaped as one that was clean, so the loss would not be neutral.
 *
 * AND ONLY THIS PROJECT'S. A desk's state/runs holds journals from whichever
 * project it was pointed at when each ran, and iids only mean anything within a
 * project. Asking GitLab about a workstreamai iid while configured for erp
 * answers 404 — which this sweep correctly refuses to read as 'clean', so every
 * foreign run would otherwise sit in the output as a permanent unreadable row
 * and hold the exit code at failure forever. They are not unreadable; they are
 * not ours, so they are excluded from the cohort the way `foreignJournals`
 * excludes them everywhere else.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, runDir } from './config.js';
import { readJournal, writeArtifact, type RunJournal } from './artifacts.js';
import { STATE } from './config.js';
import {
  DEFAULT_BOARD_LABELS, escapeRecord, type BoardLabels, type EscapeRecord, type LabelEvent,
} from './escapes.js';
import { currentProjectKey, judgeJournalHome } from './journalproject.js';

const RUNS_ARCHIVE = join(STATE, 'runs-archive');

/** One shipped ticket, as the sweep needs it. */
export interface ShippedRun {
  iid: number;
  runId: string;
  mergedSha: string;
  /** The Oneshot commit that merged it. Empty on a run from before version.ts. */
  oneshotSha: string;
  /** Where the journal was read from, so a caller can write beside it. */
  dir: string;
  archived: boolean;
}

function journalAt(dir: string): RunJournal | null {
  const p = join(dir, 'run.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as RunJournal; } catch { return null; }
}

/**
 * Every ticket this desk has shipped, live runs and archived ones alike.
 *
 * The archive is not optional: a delivered run is moved out of `state/runs` on
 * the next claim, so by the time QA has finished testing it the journal is
 * usually no longer where a naive sweep would look. Reading only the live
 * directory would quietly measure none of the older tickets — the exact set
 * whose windows have had time to close.
 */
export function shippedRuns(): ShippedRun[] {
  const out: ShippedRun[] = [];
  const seen = new Set<number>();
  const project = currentProjectKey();

  const take = (j: RunJournal | null, dir: string, archived: boolean): void => {
    if (!j?.mergedSha || !Number.isInteger(j.iid)) return;
    // With no usable GITLAB_REPO_URL nothing can be proven ours; sweeping then
    // would ask one project about another's iids.
    if (!project || judgeJournalHome(j, project).kind !== 'ours') return;
    // A re-run of the same ticket keeps the live journal, which is newer.
    if (seen.has(j.iid)) return;
    seen.add(j.iid);
    out.push({
      iid: j.iid, runId: j.runId ?? '', mergedSha: j.mergedSha,
      oneshotSha: j.oneshotSha ?? '', dir, archived,
    });
  };

  for (const name of safeList(RUNS)) {
    const iid = Number(name);
    if (!Number.isInteger(iid) || iid <= 0) continue;
    take(readJournal(iid), runDir(iid), false);
  }
  // Archived dirs are `<iid>-<runId>`, so the iid is a prefix, not the name.
  for (const name of safeList(RUNS_ARCHIVE)) {
    const dir = join(RUNS_ARCHIVE, name);
    take(journalAt(dir), dir, true);
  }
  return out.sort((a, b) => a.iid - b.iid);
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** What one ticket's sweep concluded, or why it could not. */
export interface EscapeRow extends ShippedRun {
  record: EscapeRecord | null;
  /**
   * Set when the label history could not be read. The row is then NEITHER
   * clean nor escaped — see the note on hard-failing in `collectEscapes`.
   */
  error: string | null;
}

/** How a caller supplies label history. Injected so the sweep is testable without a network. */
export type LabelEventReader = (iid: number) => Promise<
  { ok: true; events: LabelEvent[] } | { ok: false; error: string }
>;

/**
 * Sweep every shipped ticket, persist one `escapes.json` beside each run, and
 * return the rows.
 *
 * A TICKET THAT CANNOT BE READ IS AN ERROR, NEVER A CLEAN. This is the failure
 * that would quietly invalidate the whole metric: an unreadable ticket looks
 * exactly like a ticket nobody filed a bug against, so an access problem would
 * show up as a falling escape rate — the pipeline appearing to improve at
 * precisely the moment the measurement broke. It happened while this was being
 * written: a token that had been answering fine began returning 403 on every
 * endpoint, and a sweep that treated that as "no findings" would have reported a
 * perfect record. Errors are counted and surfaced, and `escapeRate` is computed
 * over readable rows only.
 */
export async function collectEscapes(
  read: LabelEventReader,
  opts: { labels?: BoardLabels; only?: readonly number[]; persist?: boolean } = {},
): Promise<EscapeRow[]> {
  const labels = opts.labels ?? DEFAULT_BOARD_LABELS;
  const runs = shippedRuns().filter((r) => !opts.only?.length || opts.only.includes(r.iid));
  const rows: EscapeRow[] = [];

  for (const run of runs) {
    const got = await read(run.iid);
    const row: EscapeRow = got.ok
      ? { ...run, record: escapeRecord(got.events, labels), error: null }
      : { ...run, record: null, error: got.error };
    rows.push(row);
    // Only for a live run: an archived directory is a historical record and
    // writing into it would make the archive mutable, which is the one property
    // that makes it trustworthy as a baseline.
    if (opts.persist !== false && !run.archived && row.record) {
      writeArtifact(run.iid, 'escapes.json', {
        iid: run.iid, runId: run.runId, mergedSha: run.mergedSha,
        oneshotSha: run.oneshotSha, sweptAt: Date.now(), ...row.record,
      });
    }
  }
  return rows;
}

/** One line per ticket, for a log or a terminal. */
export function escapeLine(row: EscapeRow): string {
  const when = (n: number | null | undefined): string =>
    (n ? new Date(n).toISOString().slice(0, 10) : '—');
  if (row.error) return `#${row.iid}  UNREADABLE  ${row.error}`;
  const r = row.record!;
  const rounds = r.rounds.length ? `  rounds=${r.rounds.length}` : '';
  const withdrawn = r.signOffWithdrawn ? '  (sign-off withdrawn)' : '';
  return `#${row.iid}  ${r.verdict.padEnd(12)} merged=${when(r.openedAt)} `
    + `signoff=${when(r.closedAt)}${rounds}  by=${row.oneshotSha || 'unknown'}${withdrawn}`;
}
