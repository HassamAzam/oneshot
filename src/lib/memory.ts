/**
 * The run memory `recall` reads: `state/memory/index.jsonl` (one line per
 * merged run) and `state/memory/tickets/<iid>.md` (its card).
 *
 * Built from the run's own artifacts in code, not by a session. The `memorize`
 * phase that used to write it went with everything past `merge`, and from then
 * on nothing wrote memory at all — recall kept reading a frozen two-ticket
 * index. `merge` now calls this once the change has landed, and
 * scripts/backfill-memory.ts runs it over merged runs from before that.
 *
 * Idempotent: the index is rewritten with this ticket's line replaced, so a
 * resumed merge or a second backfill never leaves two lines for one iid.
 * The rewrite is a read-modify-write of a file merge and backfill share, so it
 * runs under `index.lock`, and every file lands by rename so a killed process
 * never leaves a truncated index or card.
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MEMORY } from './config.js';
import { readArtifact, readJournal } from './artifacts.js';

type Obj = Record<string, unknown>;

export interface IndexLine {
  iid: number;
  title: string;
  labels: string[];
  modules: string[];
  files: string[];
  symbols: string[];
  mr: string;
  verdict: 'pass' | 'fail' | 'unverified';
  tags: string[];
  ts: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * "Expenses (Add Food Expense) — root cause in …" → "Expenses". A parenthesis
 * or a dash ends the name only after a space, so "Self-Service Portal" stays
 * whole; the en dash is in the class because "Leaves – annual" is the same
 * aside as "Leaves — annual", and leaving it out kept the whole phrase as the
 * module, which then matches no other run's.
 */
export function moduleName(module: string): string {
  return module.split(/\s+[—–(-]|,|;/)[0]!.trim();
}

/**
 * pass only when every verify case passed. The first version returned pass
 * unless a case failed, so a run whose cases were all blocked or skipped —
 * which verified nothing — entered memory as verified.
 */
export function verdictOf(verify: Obj | null | undefined): IndexLine['verdict'] {
  const results = arr<Obj>(verify?.results);
  if (!results.length) return 'unverified';
  if (results.some((r) => r.result === 'fail')) return 'fail';
  // A blocked or skipped case verified nothing.
  return results.every((r) => r.result === 'pass') ? 'pass' : 'unverified';
}

/** Write beside the target, then rename over it: readers see old or new, never half. */
function publish(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** A lock older than this is from a process that died holding it. */
const LOCK_STALE_MS = 30_000;

/** Hold an O_EXCL lockfile across `fn`. Sync, like its callers' write. */
function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_STALE_MS * 2;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; }
      } catch { continue; /* released between open and stat */ }
      if (Date.now() > deadline) throw new Error(`memory: ${lock} held too long`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

function bullets(lines: string[], empty = '(none)'): string {
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : empty;
}

/** A card for a run six months from now that has none of this context. */
function renderCard(iid: number, title: string, a: Record<string, Obj | null>): string {
  const { research, plan, implement, findings, verify } = a;
  const real = arr<Obj>(findings?.findings)
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .map((f) => `[${str(f.severity)}] ${str(f.file)}${f.line ? `:${f.line}` : ''} — ${str(f.what)}`);
  const failed = arr<Obj>(verify?.results)
    .filter((r) => r.result === 'fail')
    .map((r) => `${str(r.id)}: ${str(r.evidence).slice(0, 300)}`);
  const regressions = arr<string>(verify?.regressions);

  return `# Ticket #${iid}: ${title}

## What was asked
${str(research?.understanding) || '(unrecorded)'}

## What changed
${str(plan?.approach) || '(unrecorded)'}

Files:
${bullets(arr<string>(implement?.filesChanged))}

## What broke along the way
Review findings (blocker/major):
${bullets(real)}

Regressions verify caught:
${bullets(regressions)}

Cases that failed in verify:
${bullets(failed)}

## Risks the plan named
${bullets(arr<string>(plan?.risks))}

## What to reuse
${bullets(arr<string>(plan?.reuse))}

## Code path
${bullets(arr<Obj>(research?.codePath).map((c) => `${str(c.file)}:${c.line} — ${str(c.role)}`))}
`;
}

/**
 * Write the card and the index line for one run. Returns the index line.
 * `keepCard` leaves an existing card and index line alone — the backfill uses
 * it so what a `memorize` session wrote is not replaced by a plainer version.
 */
export function writeMemory(
  iid: number,
  opts: {
    labels?: string[]; keepCard?: boolean; mergedSha?: string | null; mrUrl?: string | null;
    /** The MR was merged outside the pipeline, so no sha was ever recorded. */
    mergedByHand?: boolean;
  } = {},
): IndexLine | null {
  const journal = readJournal(iid);
  // merge passes its own sha: its artifact is written after the record steps.
  const merge = readArtifact<Obj>(iid, 'merge.json');
  if (!journal || !(opts.mergedByHand || opts.mergedSha || merge?.mergedSha || journal.mergedSha)) return null;

  const a: Record<string, Obj | null> = {
    research: readArtifact<Obj>(iid, 'research.json'),
    plan: readArtifact<Obj>(iid, 'plan.json'),
    implement: readArtifact<Obj>(iid, 'implement.json'),
    findings: readArtifact<Obj>(iid, 'findings.json'),
    verify: readArtifact<Obj>(iid, 'verify.json'),
  };
  const title = journal.title;
  const module = str(a.research?.module);
  const line: IndexLine = {
    iid,
    title,
    labels: opts.labels ?? [],
    modules: module ? [moduleName(module)] : [],
    files: arr<string>(a.implement?.filesChanged),
    symbols: [],
    mr: opts.mrUrl || str(merge?.mrUrl) || journal.mrUrl || '',
    verdict: verdictOf(a.verify),
    tags: [],
    ts: Date.now(),
  };

  const cards = join(MEMORY, 'tickets');
  mkdirSync(cards, { recursive: true });
  const card = join(cards, `${iid}.md`);
  const index = join(MEMORY, 'index.jsonl');
  return withLock(join(MEMORY, 'index.lock'), () => {
    if (!(opts.keepCard && existsSync(card))) publish(card, renderCard(iid, title, a));

    const lines = existsSync(index) ? readFileSync(index, 'utf8').split('\n').filter((l) => l.trim()) : [];
    const isMine = (l: string): boolean => {
      try { return Number(JSON.parse(l).iid) === iid; } catch { return false; }
    };
    const existing = lines.find(isMine);
    if (opts.keepCard && existing) return JSON.parse(existing) as IndexLine;
    publish(index, [...lines.filter((l) => !isMine(l)), JSON.stringify(line)].join('\n') + '\n');
    return line;
  });
}
