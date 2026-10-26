/**
 * The live check that a design approval request carries every file the
 * design made: each screen's `before` capture, its rendered screenshot and its
 * mockup HTML, plus the prototype's entry on a flow change.
 *
 * Deterministic: no judge. After the design gate posts its request, the
 * conductor reads that comment back from GitLab and asks of every file whether
 * the comment links it as an upload. Reading the comment back rather than
 * trusting what was sent is the point: an upload that failed, a file that was
 * never written, or an attachment list that stopped including a kind of file
 * all show up here as something the reviewer cannot see.
 *
 * Research's `uiSurfaces` is the independent list of screens the ticket
 * touches. Every entry must have a design screen on its route, and every entry
 * research proves exists today — its `file:line` evidence is read from the repo
 * and must name the route — must have a `before` capture. An empty `before` on
 * a screen research does not list, or cannot prove, is left alone.
 *
 * The record belongs to the ticket, at state/runs/<iid>/design-eval.json, with
 * one round per request comment, so a redraw after feedback is checked again.
 *
 * A failing round sends the run back to `design` to write what is missing, and
 * the same comment is then edited in place and graded again — at most
 * MAX_HTML_REPAIRS times per comment, because each repair is a design session.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DesignHtmlRepair } from './artifacts.js';
import type { DesignArtifact, UiSurface } from '../phases/types.js';

export const DESIGN_EVAL_RECORD = 'design-eval.json';

/** Design re-runs one request comment may cost to get its files onto the ticket. */
export const MAX_HTML_REPAIRS = 1;

export type HtmlStatus =
  | 'linked' | 'missing-on-disk' | 'not-linked'
  | 'covered' | 'screen-missing' | 'before-missing';

export type DesignFileKind = 'before' | 'screenshot' | 'html' | 'screen';

const PASSING: ReadonlySet<HtmlStatus> = new Set(['linked', 'covered']);

export interface HtmlCheck {
  /** Artifact-relative path the design named, or the route for a `screen` / missing `before`. */
  file: string;
  /** The screen id, or `prototype` for the prototype's entry. */
  owner: string;
  kind: DesignFileKind;
  status: HtmlStatus;
}

export interface ExpectedFile {
  file: string;
  owner: string;
  kind: DesignFileKind;
}

export interface DesignEvalRound {
  noteId: number;
  at: string;
  /** False when the comment could not be read back; `files` is then empty. */
  readBack: boolean;
  files: HtmlCheck[];
  pass: boolean;
  /** The repair attempt that produced this round, when it re-grades an edited comment. */
  repair?: number;
}

export interface DesignEvalRecord {
  iid: number;
  rounds: DesignEvalRound[];
}

const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Every file the design says a reviewer should see, per screen in order:
 * `before`, then the screenshot, then the mockup HTML; the prototype entry last.
 */
export function expectedFiles(design: Partial<DesignArtifact> | null): ExpectedFile[] {
  const screens = Array.isArray(design?.screens) ? design.screens : [];
  const out = screens.flatMap((s) => {
    const owner = s?.id || s?.name || '(unnamed)';
    const files: ExpectedFile[] = [];
    if (named(s?.before)) files.push({ file: s.before, owner, kind: 'before' });
    if (named(s?.screenshot)) files.push({ file: s.screenshot, owner, kind: 'screenshot' });
    if (named(s?.mockupHtml)) files.push({ file: s.mockupHtml, owner, kind: 'html' });
    return files;
  });
  const entry = design?.prototype?.entry;
  if (named(entry)) out.push({ file: entry, owner: 'prototype', kind: 'html' });
  return out;
}

/** The last path segment of every `/uploads/<secret>/<name>` link in a note, decoded. */
export function uploadedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(/\]\(([^)\s]*\/uploads\/[^)\s]+)\)/g)) {
    const last = (m[1] ?? '').split('/').pop() ?? '';
    try {
      names.add(decodeURIComponent(last));
    } catch {
      names.add(last);
    }
  }
  return names;
}

/** GitLab rewrites an upload's filename to word characters, dots and dashes. */
const gitlabSafe = (name: string): string => name.replace(/[^\w.-]/g, '_');

/**
 * The names the gate may have uploaded a file under: its basename, or its
 * path with slashes turned to dashes when two files share a basename.
 */
function candidateNames(file: string): string[] {
  return [basename(file), file.replace(/\//g, '-')].map(gitlabSafe);
}

/** Pure: grade one request comment against the design that produced it. */
export function gradeDesignNote(
  design: Partial<DesignArtifact> | null,
  noteBody: string,
  onDisk: (file: string) => boolean,
): HtmlCheck[] {
  const linked = uploadedNames(noteBody);
  return expectedFiles(design).map(({ file, owner, kind }) => {
    if (!onDisk(file)) return { file, owner, kind, status: 'missing-on-disk' };
    const hit = candidateNames(file).some((n) => linked.has(n));
    return { file, owner, kind, status: hit ? 'linked' : 'not-linked' };
  });
}

/** A round passes when the design named at least one file and every one is linked. */
export function roundPasses(files: readonly HtmlCheck[]): boolean {
  return files.length > 0 && files.every((f) => PASSING.has(f.status));
}

const routeKey = (route: string): string => route.trim().replace(/\/+$/, '').toLowerCase() || '/';

/** How far either side of the cited line the route may be named. */
const EVIDENCE_WINDOW = 3;

/** Lower case with everything but letters and digits removed, so `PROJECT_LOGS` reads as `project-logs`. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a `file:line` citation names the route: the file exists, has that
 * line, and the route's longest literal segment appears within a few lines of
 * it, ignoring case and punctuation — so a route declared through a constant,
 * `path={ROUTE_URLS.LOGIN}`, proves `/login` as well as the literal does.
 */
export function routeEvidenceHolds(
  evidence: string, route: string, readFile: (rel: string) => string | null,
): boolean {
  const m = /^(.+):(\d+)$/.exec(evidence.trim());
  if (!m?.[1] || !m[2]) return false;
  const content = readFile(m[1]);
  if (content == null) return false;
  const lines = content.split('\n');
  const line = Number(m[2]);
  if (line < 1 || line > lines.length) return false;
  const literal = route.split('/').filter((seg) => seg && !seg.startsWith(':')).map(squash)
    .filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (!literal) return true;
  return squash(lines.slice(Math.max(0, line - 1 - EVIDENCE_WINDOW), line + EVIDENCE_WINDOW).join('\n')).includes(literal);
}

/**
 * Pure: every research surface has a design screen on its route, and every
 * surface proven to exist today has a `before` on one of those screens.
 */
export function gradeSurfaces(
  surfaces: readonly UiSurface[],
  design: Partial<DesignArtifact> | null,
  evidenceHolds: (evidence: string, route: string) => boolean,
): HtmlCheck[] {
  const screens = Array.isArray(design?.screens) ? design.screens : [];
  return surfaces.filter((sf) => named(sf?.route)).flatMap((sf): HtmlCheck[] => {
    const drawn = screens.filter((sc) => named(sc?.route) && routeKey(sc.route) === routeKey(sf.route));
    const first = drawn[0];
    if (!first) return [{ file: sf.route, owner: sf.route, kind: 'screen', status: 'screen-missing' }];
    const owner = first.id || first.name || sf.route;
    const covered: HtmlCheck = { file: sf.route, owner, kind: 'screen', status: 'covered' };
    const needsBefore = sf.exists && evidenceHolds(sf.evidence, sf.route) && !drawn.some((sc) => named(sc.before));
    return needsBefore ? [covered, { file: sf.route, owner, kind: 'before', status: 'before-missing' }] : [covered];
  });
}

/** Whether this request comment still needs grading. */
export function needsGrading(record: DesignEvalRecord | null, noteId: number | null | undefined): noteId is number {
  if (noteId == null) return false;
  return !record?.rounds.some((r) => r.noteId === noteId);
}

export interface GradeRequestDeps {
  iid: number;
  noteId: number;
  design: Partial<DesignArtifact> | null;
  artifactDir: string;
  /** Research's list; absent on runs researched before it existed, which skips the screen checks. */
  surfaces?: readonly UiSurface[];
  evidenceHolds?: (evidence: string, route: string) => boolean;
  readNote: (noteId: number) => Promise<string | null>;
  now?: () => string;
}

/** Read the posted request back and grade it. Never throws on a failed read. */
export async function gradeRequest(deps: GradeRequestDeps): Promise<DesignEvalRound> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const body = await deps.readNote(deps.noteId);
  if (body == null) return { noteId: deps.noteId, at, readBack: false, files: [], pass: false };
  const files = [
    ...gradeDesignNote(deps.design, body, (f) => existsSync(join(deps.artifactDir, f))),
    ...gradeSurfaces(deps.surfaces ?? [], deps.design, deps.evidenceHolds ?? (() => false)),
  ];
  return { noteId: deps.noteId, at, readBack: true, files, pass: roundPasses(files) };
}

export function appendRound(record: DesignEvalRecord | null, iid: number, round: DesignEvalRound): DesignEvalRecord {
  return { iid, rounds: [...(record?.rounds ?? []), round] };
}

export interface DesignEvalTotals {
  tickets: number;
  rounds: number;
  passed: number;
  unread: number;
  files: number;
  linked: number;
  notLinked: number;
  missingOnDisk: number;
  screensMissing: number;
  beforesMissing: number;
}

export function summariseDesignEval(records: readonly DesignEvalRecord[]): DesignEvalTotals {
  const rounds = records.flatMap((r) => r.rounds);
  const files = rounds.flatMap((r) => r.files);
  const count = (s: HtmlStatus): number => files.filter((f) => f.status === s).length;
  return {
    tickets: records.length,
    rounds: rounds.length,
    passed: rounds.filter((r) => r.pass).length,
    unread: rounds.filter((r) => !r.readBack).length,
    files: files.length,
    linked: count('linked'),
    notLinked: count('not-linked'),
    missingOnDisk: count('missing-on-disk'),
    screensMissing: count('screen-missing'),
    beforesMissing: count('before-missing'),
  };
}

export function formatDesignEval(records: readonly DesignEvalRecord[]): string[] {
  if (!records.length) return ['no design-eval records'];
  const lines = records.flatMap((rec) => rec.rounds.map((r) => {
    const failed = r.files.filter((f) => !PASSING.has(f.status)).map((f) => `${f.file} (${f.status})`);
    const verdict = !r.readBack ? 'UNREAD' : r.pass ? 'PASS' : 'FAIL';
    return `#${rec.iid} note ${r.noteId}  ${verdict}  ${r.files.length - failed.length}/${r.files.length} checks ok`
      + (failed.length ? `  — ${failed.join(', ')}` : '');
  }));
  const t = summariseDesignEval(records);
  return [
    ...lines,
    '',
    `tickets ${t.tickets}  rounds ${t.rounds}  passed ${t.passed}/${t.rounds}  unread ${t.unread}`,
    `checks ${t.files}: linked ${t.linked}, not linked ${t.notLinked}, missing on disk ${t.missingOnDisk}, `
      + `screens missing ${t.screensMissing}, befores missing ${t.beforesMissing}`,
  ];
}

/** What a failing round says is missing, worded for the design repair prompt. */
export function unlinkedFiles(round: DesignEvalRound): string[] {
  return round.files.filter((f) => !PASSING.has(f.status)).map((f) => {
    if (f.status === 'screen-missing') return `a screen for route ${f.file}`;
    if (f.status === 'before-missing') return `a before capture for route ${f.file}`;
    return f.file;
  });
}

/**
 * Whether a round should send the run back to `design`. Never for a comment
 * that could not be read back — that is GitLab, not the design — and never
 * past the cap for the same comment.
 */
export function repairDue(repair: DesignHtmlRepair | undefined, round: DesignEvalRound): boolean {
  if (!round.readBack || round.pass || unlinkedFiles(round).length === 0) return false;
  const used = repair?.noteId === round.noteId ? repair.attempts : 0;
  return used < MAX_HTML_REPAIRS;
}

export function nextRepair(repair: DesignHtmlRepair | undefined, round: DesignEvalRound): DesignHtmlRepair {
  const used = repair?.noteId === round.noteId ? repair.attempts : 0;
  return { noteId: round.noteId, attempts: used + 1, missing: unlinkedFiles(round), pending: true };
}

/** A pending repair is for the standing request only; one for an older comment is dropped. */
export function repairTarget(
  repair: DesignHtmlRepair | undefined, requestNoteId: number | null | undefined,
): 'edit' | 'drop' | 'none' {
  if (!repair?.pending) return 'none';
  return repair.noteId === requestNoteId ? 'edit' : 'drop';
}
