/**
 * The check that a design approval request carries every file the design
 * made: each screen's `before` capture, its rendered screenshot and its mockup
 * HTML, plus the prototype's entry on a flow change.
 *
 * Deterministic: no judge, and it grades the comment the gate has PREPARED,
 * before that comment is posted. Every file the design names must be on disk
 * and carried by the prepared comment, and every research screen must be
 * covered; a failure sends the run back to `design` before any reviewer is
 * pinged, so nobody can reply to a request that is about to change. It runs
 * ahead of every request comment, including the fresh one a rejected design
 * earns once it has been redrawn.
 *
 * Grading what is about to be posted is the whole check. Reading the comment
 * back afterwards could only name an upload the run is no longer allowed to do
 * anything about — the comment is never edited, because a reply on it is a
 * verdict on what it showed — so the attachment list the gate is holding is
 * both the earlier and the more actionable evidence.
 *
 * Research's `uiSurfaces` is the independent list of screens the ticket
 * touches. Every entry must have a design screen on its route, and every entry
 * research proves exists today — its `file:line` evidence is read from the repo
 * and must name the route — must have a `before` capture. An empty `before` on
 * a screen research does not list, or cannot prove, is left alone.
 *
 * The record belongs to the ticket, at state/runs/<iid>/design-eval.json, with
 * one round per prepared comment, so a redraw after feedback is checked again.
 *
 * A failed check costs at most MAX_HTML_REPAIRS design re-runs per request,
 * because each one is a design session; past that the request posts as it
 * stands and the round records what is missing.
 */

import { basename } from 'node:path';
import type { DesignHtmlRepair } from './artifacts.js';
import type { DesignArtifact, UiSurface } from '../phases/types.js';

export const DESIGN_EVAL_RECORD = 'design-eval.json';

/** Design re-runs one request may cost, before it is posted, to produce what it is missing. */
export const MAX_HTML_REPAIRS = 1;

export type HtmlStatus =
  | 'attached' | 'not-attached' | 'missing-on-disk'
  | 'covered' | 'screen-missing' | 'before-missing';

export type DesignFileKind = 'before' | 'screenshot' | 'html' | 'screen';

const PASSING: ReadonlySet<HtmlStatus> = new Set(['attached', 'covered']);

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
  at: string;
  /** Design repairs already spent on this request when the comment was graded. */
  attempt: number;
  files: HtmlCheck[];
  pass: boolean;
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

/** GitLab rewrites an upload's filename to word characters, dots and dashes. */
const gitlabSafe = (name: string): string => name.replace(/[^\w.-]/g, '_');

/**
 * The names the gate may have attached a file under: its basename, or its
 * path with slashes turned to dashes when two files share a basename.
 */
function candidateNames(file: string): string[] {
  return [basename(file), file.replace(/\//g, '-')].map(gitlabSafe);
}

/** A round passes when the design named at least one file and every check is good. */
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

export interface BeforePostingCheck {
  design: Partial<DesignArtifact> | null;
  /** The names the prepared comment will upload under, as the gate labelled them. */
  attached: readonly string[];
  onDisk: (file: string) => boolean;
  /** Research's list; empty on runs researched before it existed, which skips the screen checks. */
  surfaces: readonly UiSurface[];
  evidenceHolds: (evidence: string, route: string) => boolean;
}

/**
 * Pure: what the prepared request comment is missing — every file the design
 * names must be on disk and carried by that comment, and every research
 * surface must be covered.
 *
 * On disk but not carried is kept apart from never written: one is a file the
 * gate dropped as too large to attach, the other a render the design never
 * made, and `design` is sent back to do different work for each.
 */
export function checkBeforePosting(check: BeforePostingCheck): HtmlCheck[] {
  const attached = new Set(check.attached.map(gitlabSafe));
  return [
    ...expectedFiles(check.design).map(({ file, owner, kind }): HtmlCheck => {
      if (!check.onDisk(file)) return { file, owner, kind, status: 'missing-on-disk' };
      const carried = candidateNames(file).some((n) => attached.has(n));
      return { file, owner, kind, status: carried ? 'attached' : 'not-attached' };
    }),
    ...gradeSurfaces(check.surfaces, check.design, check.evidenceHolds),
  ];
}

export function appendRound(record: DesignEvalRecord | null, iid: number, round: DesignEvalRound): DesignEvalRecord {
  return { iid, rounds: [...(record?.rounds ?? []), round] };
}

export interface DesignEvalTotals {
  tickets: number;
  rounds: number;
  passed: number;
  files: number;
  attached: number;
  notAttached: number;
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
    files: files.length,
    attached: count('attached'),
    notAttached: count('not-attached'),
    missingOnDisk: count('missing-on-disk'),
    screensMissing: count('screen-missing'),
    beforesMissing: count('before-missing'),
  };
}

export function formatDesignEval(records: readonly DesignEvalRecord[]): string[] {
  if (!records.length) return ['no design-eval records'];
  const lines = records.flatMap((rec) => rec.rounds.map((r) => {
    const failed = r.files.filter((f) => !PASSING.has(f.status)).map((f) => `${f.file} (${f.status})`);
    return `#${rec.iid} attempt ${r.attempt}  ${r.pass ? 'PASS' : 'FAIL'}  `
      + `${r.files.length - failed.length}/${r.files.length} checks ok`
      + (failed.length ? `  — ${failed.join(', ')}` : '');
  }));
  const t = summariseDesignEval(records);
  return [
    ...lines,
    '',
    `tickets ${t.tickets}  rounds ${t.rounds}  passed ${t.passed}/${t.rounds}`,
    `checks ${t.files}: attached ${t.attached}, not attached ${t.notAttached}, missing on disk ${t.missingOnDisk}, `
      + `screens missing ${t.screensMissing}, befores missing ${t.beforesMissing}`,
  ];
}

/** What a set of checks says is missing, worded for the design repair prompt. */
export function missingItems(files: readonly HtmlCheck[]): string[] {
  return files.filter((f) => !PASSING.has(f.status)).map((f) => {
    if (f.status === 'screen-missing') return `a screen for route ${f.file}`;
    if (f.status === 'before-missing') return `a before capture for route ${f.file}`;
    return f.file;
  });
}

/**
 * Whether a failed check before posting should send the run back to `design`:
 * only when something is missing, and never past the cap for this request.
 */
export function repairDue(repair: DesignHtmlRepair | undefined, files: readonly HtmlCheck[]): boolean {
  if (roundPasses(files) || missingItems(files).length === 0) return false;
  return (repair?.attempts ?? 0) < MAX_HTML_REPAIRS;
}

export function nextRepair(repair: DesignHtmlRepair | undefined, files: readonly HtmlCheck[]): DesignHtmlRepair {
  return { attempts: (repair?.attempts ?? 0) + 1, missing: missingItems(files), pending: true };
}
