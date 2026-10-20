/**
 * Publish a run's artifacts to GitLab AS THEY LAND, not at the end.
 *
 * `merge` writes the run's durable record, but it is the last phase — so for
 * most of a run's life the ticket would say nothing and whoever is watching
 * would have to read a Slack card to learn anything. That is backwards for the
 * two artifacts people actually want early: the PLAN, which is the last cheap
 * moment to say "not like that", and the TEST CASES, which QA wants in their
 * own format while the change is still being written.
 *
 * Two decisions shape this file:
 *
 * 1. It is CODE, not a phase. A model that is asked to publish as a side errand
 *    skips it under load, and a whole extra session per artifact is absurd for
 *    what is a render and two API calls.
 *
 * 2. It RECONCILES rather than queues. Every call walks the full spec list and
 *    publishes anything whose artifact exists and whose key is not yet in
 *    `journal.published`. Nothing has to be scheduled, a target that is not
 *    ready yet (an MR that does not exist at `verify` time) is simply retried
 *    on the next phase, and a resumed run backfills everything it missed while
 *    the feature did not exist. Idempotency is the same property, so a crash
 *    between the upload and the note re-posts at most one note.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { artifactDir, localTestsPatchFile, reviewersConfig, WORK_REPO } from './config.js';
import { readArtifact, readJournal, updateJournal, type RunJournal } from './artifacts.js';
import {
  addIssueNote, addMergeRequestNote, mergeRequestUrl, projectUrl, uploadFile, type Upload,
} from './gitlab.js';
import { log } from './log.js';
import { codeSpan, mdText, tableCell } from './gitlabmd.js';
import { fileChangesSection, renderFileChanges } from './planfiles.js';
import { flowSection, renderFlowMermaid } from './planflow.js';
import type { BaseCheck, LocalTestsRun, LocalTestsScope } from '../phases/types.js';

/** GitLab rejects very large attachments; skip them with a note rather than failing. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.patch': 'text/x-diff',
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// ------------------------------------------------------------------ rendering

/** One CSV field: quoted always, inner quotes doubled. Steps keep their newlines. */
export function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

interface PlanArtifact {
  approach?: string;
  reuse?: string[];
  steps?: Array<{ n: number; what: string; files: string[]; layer: string }>;
  migrations?: boolean;
  risks?: string[];
  /** The next three are absent on plans written before they existed. */
  openQuestions?: string[];
  outOfScope?: string[];
  acceptanceCoverage?: Array<{ criterion: string; coveredBy: string; status: string; note: string }>;
  feedbackResponse?: Array<{ point: string; response: string; where: string; note: string }>;
  /** Unvalidated here: planfiles.ts and planflow.ts check them field by field, and old plans lack both. */
  fileChanges?: unknown;
  flow?: unknown;
  summary?: string;
}

/** A `files` entry's path, with any trailing `:<line>`(`-<end>`) stripped off. */
function refPath(file: string): string {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(file.trim());
  return m ? m[1]! : file.trim();
}

/**
 * Which of `paths` exist in the work repo at `baseSha`.
 *
 * A plan routinely names files it is about to CREATE. Those do not exist at the
 * fork point, so a blob link to them 404s and must render as plain text. Checked
 * against the local clone in one `git cat-file` batch. Any failure — missing
 * clone, unknown sha, or the 10s timeout that stops an unresponsive `WORK_REPO`
 * mount from holding the event loop on this synchronous phase-advance call —
 * yields an empty set, and the caller then links nothing: a missing link is
 * always safer than a dead one.
 */
function pathsAtRef(baseSha: string, paths: string[]): Set<string> {
  const present = new Set<string>();
  if (!paths.length) return present;
  try {
    const input = `${paths.map((p) => `${baseSha}:${p}`).join('\n')}\n`;
    const out = execFileSync(
      'git', ['-C', WORK_REPO, 'cat-file', '--batch-check=%(objecttype)'],
      { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
    ).split('\n');
    paths.forEach((p, i) => { if (out[i] === 'blob') present.add(p); });
  } catch {
    // Leave empty: caller renders every path plain rather than risk a dead link.
  }
  return present;
}

/**
 * A step's file path as a GitLab blob link, pinned to the plan's base commit.
 *
 * `blobBase` is `<projectUrl>/-/blob/<baseSha>`, so the link always resolves to
 * the code the plan was written against and never drifts as the branch moves.
 * An optional trailing `:<line>` (or `:<start>-<end>`) becomes a `#L` anchor.
 * `exists` guards against dead links: a path that is not a blob at the base
 * commit (a file the plan will create) renders as plain text. Without `blobBase`
 * — an old run with no stored SHA — every path renders as escaped text.
 *
 * Each path SEGMENT is URL-encoded: a space, `#`, `(` or `)` in a path
 * otherwise ends the CommonMark link destination early and spills the tail into
 * the cell as literal text. Encoding per segment keeps the `/` separators.
 * `encodeURIComponent` leaves `(` and `)` alone, so they are encoded explicitly
 * — an unbalanced paren in a path would otherwise still truncate the link.
 */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function fileCell(file: string, blobBase?: string, exists?: (path: string) => boolean): string {
  const label = tableCell(file);
  if (!blobBase) return label;
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(file.trim());
  const path = m ? m[1]! : file.trim();
  if (exists && !exists(path)) return label;
  const url = path.split('/').map(encodeSegment).join('/');
  const anchor = m ? `#L${m[2]}${m[3] ? `-${m[3]}` : ''}` : '';
  return `[${label}](${blobBase}/${url}${anchor})`;
}

export function renderPlanMd(
  iid: number, title: string, plan: PlanArtifact, baseSha?: string,
  existsAt?: (path: string) => boolean,
): string {
  // Every cell holding model prose goes through `tableCell`; `layer` and
  // `status` are schema enums and `n` is a number, so they cannot break a row.
  // `files` are paths joined with `<br>` — that is a rendering choice for an
  // array, not an escape, which is why the path itself still needs one.
  const blobBase = baseSha ? `${projectUrl()}/-/blob/${baseSha}` : undefined;
  // `existsAt` overrides the default existence check, which tests use to drive
  // link rendering without a real repo. The default resolves existence once per
  // render, not per file: a plan touches a handful of paths and one
  // `git cat-file` batch against the work repo answers for all of them.
  let exists: ((path: string) => boolean) | undefined;
  if (baseSha) {
    const present = existsAt
      ? null
      : pathsAtRef(baseSha, [...new Set((plan.steps ?? []).flatMap((s) => (s.files ?? []).map(refPath)))]);
    exists = existsAt ?? ((p: string) => present!.has(p));
  }
  const steps = (plan.steps ?? [])
    .map((s) => `| ${s.n} | ${s.layer} | ${tableCell(s.what)} | ${
      (s.files ?? []).map((f) => fileCell(f, blobBase, exists)).join('<br>') || '—'} |`)
    .join('\n');
  // Prose is interpolated into a RENDERED note body now, not a raw-served
  // attachment, so every free-text field goes through `mdText`: a risk reading
  // `<title> is not refreshed` would otherwise open an HTML block and GitLab's
  // sanitiser would eat the tag and the rest of the block. Table cells already
  // escape via `tableCell`; these bullets and the approach did not.
  const questions = (plan.openQuestions ?? []).map((q) => `- ${mdText(String(q))}`).join('\n');
  const outOfScope = (plan.outOfScope ?? []).map((o) => `- ${mdText(String(o))}`).join('\n');
  const answered = (plan.feedbackResponse ?? [])
    .map((f) => `| ${tableCell(f.point)} | ${tableCell(f.response)} | ${
      tableCell(f.where) || '—'} | ${tableCell(f.note)} |`)
    .join('\n');
  const coverage = (plan.acceptanceCoverage ?? [])
    .map((c) => `| ${tableCell(c.criterion)} | ${c.status} | ${
      tableCell(c.coveredBy) || '—'} | ${tableCell(c.note)} |`)
    .join('\n');
  // Same order as the approval comment: the picture before the prose, and the
  // file tables directly above the steps they summarise.
  const flow = flowSection(plan.flow);
  const files = fileChangesSection(plan);
  return `# Implementation plan — #${iid} ${title}

${answered ? `## Reviewer feedback, point by point\n| Point | Response | Where | Note |\n|---|---|---|---|\n${answered}\n\n` : ''}${
  flow ? `## Flow — the runtime path this plan touches\n${flow}\n\n` : ''}## Approach
${plan.approach ? mdText(String(plan.approach)) : '(not recorded)'}
${questions ? `\n## Open questions — answer these in a comment, or the stated default is used\n${questions}\n` : ''}${files ? `\n## What changes\n${files}\n` : ''}
## Steps
| # | Layer | Change | Files |
|---|---|---|---|
${steps || '| — | — | (none recorded) | — |'}
${coverage ? `\n## Acceptance coverage\n| Criterion | Status | Covered by | Note |\n|---|---|---|---|\n${coverage}\n` : ''}
## Prior art and verdicts
${(plan.reuse ?? []).map((r) => `- ${mdText(String(r))}`).join('\n') || '- (none identified)'}

## Risks
${(plan.risks ?? []).map((r) => `- ${mdText(String(r))}`).join('\n') || '- (none identified)'}
${outOfScope ? `\n## Out of scope\n${outOfScope}\n` : ''}
## Migrations
${plan.migrations ? 'This change requires a database migration.' : 'No schema change.'}
`;
}

interface TestCase {
  id: string;
  scenario: string;
  precondition: string;
  steps: string[];
  expected: string;
  pass: string[];
  blast: string;
}

function renderTestcasesCsv(cases: TestCase[]): string {
  const head = ['ID', 'Test Scenario', 'Pre Condition', 'Steps', 'Expected Result', 'Passes', 'Blast']
    .map(csvCell).join(',');
  const rows = cases.map((c) => [
    c.id,
    c.scenario,
    c.precondition || '—',
    (c.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    c.expected,
    (c.pass ?? []).join(', '),
    c.blast,
  ].map(csvCell).join(','));
  return [head, ...rows].join('\n');
}

interface CaseResult {
  id: string;
  result: string;
  evidence: string;
  screenshot: string;
}

function resultTable(results: CaseResult[]): string {
  const icon: Record<string, string> = {
    pass: ':white_check_mark:', fail: ':x:', blocked: ':warning:', skipped: ':heavy_minus_sign:',
    'pre-existing': ':leftwards_arrow_with_hook:',
  };
  return ['| Case | Result | Evidence |', '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${icon[r.result] ?? ''} ${r.result} | ${
      (r.evidence ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`),
  ].join('\n');
}

interface Observation { what: string; before: string; after: string; how: string; caseId: string }

/**
 * A measured value, verbatim. Values go in code spans and prose is entity-escaped,
 * so `<title>` and `<script>` survive GitLab's sanitizer as text. An empty value
 * is shown as empty rather than as a dash: when a missing page title is the bug,
 * the empty base-branch value IS the finding, and a dash reads as "not recorded".
 */
/** One table cell as a code span, or an explicit `_(empty)_` — see `observationTable`. */
function code(v: string): string {
  const s = String(v ?? '').replace(/\n/g, ' ').slice(0, 160);
  return s ? `\`${s.replace(/`/g, "'").replace(/\|/g, '\\|')}\`` : '_(empty)_';
}

/** One table cell as prose: entity-escaped, single-line, pipe-safe. */
function text(v: string): string {
  return String(v ?? '').replace(/\n/g, ' ').slice(0, 160)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');
}

function observationTable(rows: Observation[]): string {
  return ['| What | Before (base) | After (this branch) | Measured by | Case |', '|---|---|---|---|---|',
    ...rows.slice(0, 30).map((o) =>
      `| ${text(o.what)} | ${code(o.before)} | ${code(o.after)} | ${text(o.how)} | ${o.caseId || ''} |`),
  ].join('\n');
}

interface DesignPair {
  screenId: string; designShot: string; builtShot: string; differences: string[];
}

/**
 * Approved design versus what shipped, one row per screen.
 *
 * The differences column, not the check mark, is the content: a reviewer who
 * approved these screens is asking "did I get what I signed off", and a row
 * that says only "yes" is an assertion where a list would be evidence. An
 * empty list renders as the claim it is — "no departures recorded" — rather
 * than as a tick that could equally mean nobody looked.
 */
function conformanceTable(rows: DesignPair[]): string {
  return [
    '**Approved design vs. shipped**',
    '',
    '| Screen | Approved | Built | Departures |',
    '|---|---|---|---|',
    ...rows.slice(0, 20).map((r) => `| ${text(r.screenId)} | ${code(r.designShot)} | `
      + `${r.builtShot ? code(r.builtShot) : '_not reached_'} | `
      + `${(r.differences ?? []).length
        ? (r.differences).map((d) => tableCell(String(d))).join('<br>')
        : '_none recorded_'} |`),
  ].join('\n');
}

function tally(results: CaseResult[]): string {
  const counts = results.reduce<Record<string, number>>((a, r) => {
    a[r.result] = (a[r.result] ?? 0) + 1;
    return a;
  }, {});
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no cases';
}

// ------------------------------------------------------------------- the specs

interface Attachment { name: string; content: Buffer | string; mime: string }

interface Publication {
  body: string;
  attachments: Attachment[];
}

interface Spec {
  key: string;
  artifact: string;
  target: 'ticket' | 'mr';
  /**
   * A ticket note that TALKS ABOUT the MR. `target: 'mr'` already implies the
   * MR must exist, but a note posted on the ticket has no such guarantee, and
   * `build` cannot express "not ready yet" — returning null retires the key
   * permanently. So the wait belongs in the loop's guard, where a spec whose
   * MR has not been opened is simply skipped and reconsidered next pass.
   */
  needsMr?: boolean;
  build: (data: Record<string, unknown>, ctx: PublishCtx) => Publication | null;
}

/** Screenshot files a phase's results reference, read off disk. */
function screenshotsFrom(iid: number, results: CaseResult[], limit: number): Attachment[] {
  const dir = artifactDir(iid);
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.screenshot || seen.has(r.screenshot) || out.length >= limit) continue;
    seen.add(r.screenshot);
    const p = join(dir, r.screenshot);
    if (!existsSync(p)) continue;
    const content = readFileSync(p);
    if (content.length > MAX_UPLOAD_BYTES) continue;
    out.push({ name: r.screenshot, content, mime: mimeFor(r.screenshot) });
  }
  return out;
}

/**
 * The base-branch screenshot behind each confirmed 'pre-existing' case, shaped
 * so screenshotsFrom() can attach it.
 *
 * base-check is required to save one (`base-<case-id>.png`) for every case it
 * scores 'fails', and that image is the proof the MR note asks a reviewer to
 * confirm. Without this the shot was captured and dropped: the note said
 * "confirmed on <base>" and the evidence sat unpublished in artifacts/. Only a
 * case still labelled after applyBaseCheck() counts, and only an entry the
 * check scored 'fails', so a refused label never shows a base shot.
 */
export function baseShotsFor(results: CaseResult[], check: BaseCheck | null): CaseResult[] {
  const shots: CaseResult[] = [];
  for (const r of results) {
    if (r.result !== 'pre-existing') continue;
    const seen = (check?.results ?? []).find((c) => c.id === r.id && c.onBase === 'fails');
    const shot = typeof seen?.screenshot === 'string' ? seen.screenshot.trim() : '';
    if (shot) shots.push({ id: r.id, result: r.result, evidence: '', screenshot: shot });
  }
  return shots;
}

// ---------------------------------------------------------------- local tests

/*
 * The local automation tests mode's renderers. That mode runs after the merge
 * (src/localtests) and posts its own notes, so none of these is in SPECS below:
 * publishPending serves the Loop, and the Loop no longer runs local tests.
 */

/**
 * Model or tool prose for one line of a note: escaped like every other field
 * here, and folded onto one line so a stray newline cannot end a list item or
 * a table row early.
 */
function oneLine(v: unknown): string {
  return mdText(String(v ?? '')).replace(/\s*\n\s*/g, ' ').trim();
}

/** `oneLine` without the full stop the note adds itself, so a sentence never ends `..`. */
function clause(v: unknown): string {
  return oneLine(v).replace(/[.\s]+$/, '');
}

/** Inside `*…*`, where a stray asterisk would end the emphasis early. */
function italic(v: unknown): string {
  return `*${clause(v).replace(/\*/g, '\\*')}*`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A list of a scope's specs or edits, from an artifact nothing has validated. */
function listOf<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : [];
}

/**
 * A model-supplied spec or file path as a code span, but escaped when it holds
 * a `<!--`: codeSpan does not escape, so a crafted `specs[].file` could carry a
 * forged `<!-- oneshot:local-tests:... -->` marker that postOnce()/otherDeskRun()
 * read as real, suppressing the true note or claiming a foreign desk owns the run.
 */
function pathText(file: string): string {
  return file.includes('<!--') ? mdText(file) : codeSpan(file);
}

/** `notRunnable` entries as "`spec` (why)", one string each. */
function notRunnableItems(v: unknown): string[] {
  return listOf<{ spec?: unknown; why?: unknown }>(v)
    .filter((n) => String(n.spec ?? '').trim())
    .map((n) => `${pathText(String(n.spec).trim())}${clause(n.why) ? ` (${clause(n.why)})` : ''}`);
}

/**
 * Whether a scope is worth a note: one that reports itself blocked never
 * finished, and a plan — or a "not needed" line — about it would be a note
 * about work that was never done.
 */
export function localTestsScopeReady(data: Record<string, unknown>): boolean {
  return !(typeof data.blocked === 'string' && data.blocked.trim());
}

/**
 * The local-tests plan on the ticket (`local-tests-scope`).
 *
 * Written for the QA and the developer who will read it, not for whoever
 * built the pipeline: what will run, why, and anything about the team's tests
 * that changes. A ticket with nothing to run gets one line rather than an
 * empty plan, so nobody wonders whether the step was skipped.
 *
 * The proposals are the part QA has to act on, so each says which way it goes
 * in capitals. The patch of temporary changes is attached because "we edited
 * a spec to match" is a claim, and the diff is the evidence.
 *
 * Specs that reach the change but cannot run on a desk (`notRunnable`) are
 * named on both shapes of the note, the one-line one included: "not needed"
 * alone would read as "nothing covers this" when something does, elsewhere.
 */
export function localTestsPlanNote(data: Record<string, unknown>, ctx: PublishCtx): Publication {
  const scope = data as Partial<LocalTestsScope>;
  const notRunnable = notRunnableItems(scope.notRunnable);
  if (scope.applicable !== true) {
    return {
      body: `**Local automation tests:** not needed for this ticket — ${
        clause(scope.reason) || 'no automation test covers what it changes'}.${
        notRunnable.length ? ` Tests that reach it but can't run on a local machine: ${notRunnable.join('; ')}.` : ''}`,
      attachments: [],
    };
  }

  const specs = listOf<LocalTestsScope['specs'][number]>(scope.specs);
  const edits = listOf<LocalTestsScope['edits'][number]>(scope.edits);
  const proposals = listOf<LocalTestsScope['proposals'][number]>(scope.proposals);
  const modules = (Array.isArray(scope.modules) ? scope.modules : []).map(oneLine).filter(Boolean);
  const cases = specs.reduce((n, s) => n + (Number(s.cases) || 0), 0);
  const est = Number(scope.estimatedMinutes);

  // A plan is read on the ticket, often by QA deciding whether to approve it: the
  // first PLAN_TABLE_ROWS specs are the table, and any beyond that stay one click
  // away in a collapsed list rather than turning the note into a wall of rows.
  const row = (s: LocalTestsScope['specs'][number]): string =>
    `| ${tableCell(pathText(String(s.file ?? '')))} | ${tableCell(s.module)} | ${tableCell(s.why)} |`;
  const rest = specs.slice(PLAN_TABLE_ROWS);
  const summary = oneLine(scope.summary);
  const parts = [
    '**Local automation tests — plan**',
    summary.length > PLAN_SUMMARY_CHARS ? `${summary.slice(0, PLAN_SUMMARY_CHARS).trimEnd()}…` : summary,
    [
      `**Modules:** ${modules.join(', ') || '—'}`,
      `**Tests:** ${plural(specs.length, 'spec file')}, ${plural(cases, 'test case')}`,
      ...(Number.isFinite(est) && est > 0 ? [`**About ${Math.max(1, Math.round(est))} min**`] : []),
    ].join(' · '),
    ['| Spec file | Module | Why |', '|---|---|---|', ...specs.slice(0, PLAN_TABLE_ROWS).map(row)].join('\n'),
    ...(rest.length
      ? [`<details><summary>…and ${plural(rest.length, 'more spec file')}</summary>\n\n${
        ['| Spec file | Module | Why |', '|---|---|---|', ...rest.map(row)].join('\n')}\n\n</details>`]
      : []),
  ];
  if (proposals.length) {
    parts.push(`**Proposed change to the test list (QA approval needed):**\n${proposals.map((p) => {
      if (p.action === 'remove') {
        // A remove names the file, and the test when it is one case inside
        // it: "REMOVE: leaves.cy.ts" alone would read as the whole file going.
        const file = String(p.file ?? '').trim();
        const what = file
          ? `${pathText(file)}${clause(p.title) ? ` — ${clause(p.title)}` : ''}`
          : clause(p.title);
        return `- REMOVE: ${what}. ${italic(`Why: ${clause(p.why)}`)}`;
      }
      return `- ADD a new test: ${clause(p.title)}. ${italic(`Why: ${clause(p.why)}`)}`;
    }).join('\n')}`);
  }
  // Split by kind: a file the scope created is not an existing test that was
  // changed, and saying so would hide that the run covers something new.
  const bullets = (kind: 'update' | 'add'): string => edits.filter((e) => e.kind === kind)
    .map((e) => `- ${pathText(String(e.file ?? ''))} — ${clause(e.why)}`).join('\n');
  const changed = bullets('update');
  const added = bullets('add');
  if (changed) parts.push(`**Existing tests changed for this run (temporary, not committed):**\n${changed}`);
  if (added) parts.push(`**New tests added for this run (temporary, not committed):**\n${added}`);
  if (notRunnable.length) {
    parts.push(`**Tests that can't run on a local machine (not run):**\n${notRunnable.map((n) => `- ${n}`).join('\n')}`);
  }

  const attachments: Attachment[] = [];
  const patch = localTestsPatchFile(ctx.iid);
  if (existsSync(patch)) {
    const content = readFileSync(patch);
    if (content.length > MAX_UPLOAD_BYTES) {
      parts.push('_The patch of temporary changes is over 25 MB, so it is not attached._');
    } else {
      attachments.push({ name: basename(patch), content, mime: mimeFor(patch) });
    }
  }
  return { body: parts.filter(Boolean).join('\n\n'), attachments };
}

/**
 * Whether a failed local test fails on dev too, in the words the reader of the
 * results needs: is this the ticket's change? Exported so every note that
 * names a failure words one answer the same way.
 */
export function failingOnDevText(v: boolean | null | undefined): string {
  if (v === true) return 'yes — not caused by this ticket';
  if (v === false) return 'no — likely caused by this ticket';
  return 'unknown';
}

/** The first line of a Cypress error, which is the assertion; the rest is a stack. */
function firstLine(v: unknown): string {
  const line = String(v ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/** Minutes between two ISO stamps, or across the tests when a stamp is unreadable. */
function runMinutes(run: Partial<LocalTestsRun>, results: LocalTestsRun['results']): string {
  const span = Date.parse(String(run.endedAt)) - Date.parse(String(run.startedAt));
  const ms = Number.isFinite(span) && span >= 0
    ? span : results.reduce((n, r) => n + (Number(r.durationMs) || 0), 0);
  return ms > 0 && ms < 60_000 ? '<1' : String(Math.round(ms / 60_000));
}

/** Specs shown in the plan's table; the rest of the list sits in a collapsed block under it. */
const PLAN_TABLE_ROWS = 10;

/** The plan's opening summary is clipped here: the table, not the paragraph, is what QA approves. */
const PLAN_SUMMARY_CHARS = 400;

/** At most this many table rows; a run with more failures than this has a bigger problem than the table. */
const MAX_RESULT_ROWS = 60;

/** At most this many of the script's notes are listed; past that they are noise, not explanation. */
const MAX_RUN_NOTES = 15;

/** What a test that failed once and passed on its retry is called, in every note that names one. */
export const FLAKY_TEXT = 'passed on retry — flaky';

/** The run's notes as one-line strings, from an artifact nothing has validated. */
export function runNotes(run: { notes?: unknown } | null | undefined): string[] {
  const notes = Array.isArray(run?.notes) ? run.notes : [];
  return notes.map((n) => (typeof n === 'string' ? oneLine(n) : '')).filter(Boolean);
}

/**
 * The local-tests report on the ticket (`local-tests-run`).
 *
 * One row per test that needs a look — failed, then passed only on a retry,
 * then skipped — and one row per spec for what passed cleanly, so forty green
 * tests do not bury the red one. Each failure says whether it also fails on
 * dev, because that is the question whoever reads the results is actually
 * answering: is this the ticket's change? A test that passed only on its retry is
 * its own row, not a green count: it is a flaky test, or a change that made
 * one flaky, and either way somebody should know.
 *
 * Whatever cut the run short (`reason`, e.g. Cypress stopped at its deadline)
 * is in the header line, and the script's notes close the note — the one
 * place that says why "failing on dev too?" reads unknown.
 *
 * The videos of failed specs are attached under the note (they render as
 * players on GitLab), which puts them after the closing lines rather than
 * beside their rows; any too large to upload is named instead.
 */
export function localTestsReportNote(data: Record<string, unknown>, ctx: PublishCtx): Publication | null {
  const run = data as Partial<LocalTestsRun>;
  if (run.status === 'skipped') {
    const notRunnable = notRunnableItems(run.notRunnable);
    return {
      body: `**Local automation tests:** skipped — ${clause(run.reason) || 'no reason was recorded'}.${
        notRunnable.length ? ` Tests that can't run on a local machine: ${notRunnable.join('; ')}.` : ''}`,
      attachments: [],
    };
  }
  if (run.status === 'error') {
    return {
      body: `**Local automation tests:** could not be run — ${
        clause(run.reason) || 'no reason was recorded'}. No results were recorded.`,
      attachments: [],
    };
  }
  if (run.status !== 'passed' && run.status !== 'failed') return null;

  const results = listOf<LocalTestsRun['results'][number]>(run.results);
  const count = (state: string): number => results.filter((r) => r.state === state).length;
  const totals = run.totals ?? {
    specs: new Set(results.map((r) => r.spec)).size,
    tests: results.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'),
  };

  const testRow = (r: LocalTestsRun['results'][number], result: string, devToo: string): string =>
    `| ${tableCell(pathText(String(r.spec ?? '')))}<br>${tableCell(r.title)} | ${result} | ${devToo} | `
    + `${tableCell(firstLine(r.error))} |`;
  const flaky = results.filter((r) => r.state === 'passed' && r.flaky === true);
  const passedBySpec = new Map<string, number>();
  for (const r of results.filter((x) => x.state === 'passed' && x.flaky !== true)) {
    const spec = String(r.spec ?? '');
    passedBySpec.set(spec, (passedBySpec.get(spec) ?? 0) + 1);
  }
  const rows = [
    ...results.filter((r) => r.state === 'failed')
      .map((r) => testRow(r, ':x: failed', failingOnDevText(r.failingOnDev))),
    ...flaky.map((r) => testRow(r, `:warning: ${FLAKY_TEXT}`, '—')),
    ...results.filter((r) => r.state === 'skipped').map((r) => testRow(r, ':heavy_minus_sign: skipped', '—')),
    ...[...passedBySpec].map(([spec, n]) =>
      `| ${tableCell(pathText(spec))} | :white_check_mark: passed (${plural(n, 'test')}) | — |  |`),
  ];

  const cutShort = clause(run.reason);
  const parts = [
    `**Local automation results** — ${totals.passed} passed${
      flaky.length ? ` (${flaky.length} only on a retry)` : ''}, ${totals.failed} failed (${
      plural(totals.tests, 'test')}, ${runMinutes(run, results)} min)${cutShort ? `. ${cutShort}.` : ''}`,
  ];
  if (rows.length) {
    parts.push(['| Spec | Result | Failing on dev too? | Reason |', '|---|---|---|---|',
      ...rows.slice(0, MAX_RESULT_ROWS)].join('\n')
      + (rows.length > MAX_RESULT_ROWS ? `\n\n_…and ${rows.length - MAX_RESULT_ROWS} more rows not shown._` : ''));
  }

  const scope = readArtifact<Partial<LocalTestsScope>>(ctx.iid, 'local-tests-scope.json');
  // The run echoes the list it was handed; the plan is the fallback for a run
  // recorded before it carried one.
  const fromRun = notRunnableItems(run.notRunnable);
  const notRunnable = fromRun.length ? fromRun : notRunnableItems(scope?.notRunnable);
  const changed = listOf<LocalTestsScope['edits'][number]>(scope?.edits)
    .filter((e) => e.kind === 'update').map((e) => pathText(String(e.file ?? '')));
  const added = (Array.isArray(run.newTests) ? run.newTests : []).map(clause).filter(Boolean);
  parts.push(`**Tests that can't run on a local machine:** ${notRunnable.join('; ') || 'none'}`);
  parts.push(`**Existing tests changed for this run:** ${changed.join(', ') || 'none'}`);
  parts.push(`**New tests added for this run:** ${added.join('; ') || 'none'}`);
  const notes = runNotes(run);
  if (notes.length) {
    parts.push(`**Notes from the run:**\n${notes.slice(0, MAX_RUN_NOTES).map((n) => `- ${n}`).join('\n')}${
      notes.length > MAX_RUN_NOTES ? `\n- …and ${notes.length - MAX_RUN_NOTES} more` : ''}`);
  }

  // Videos of the failed specs, once per file, named apart when two specs'
  // recordings share a file name.
  const dir = artifactDir(ctx.iid);
  const attachments: Attachment[] = [];
  const tooLarge: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const r of results) {
    const rel = r.state === 'failed' && typeof r.video === 'string' ? r.video.trim() : '';
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const full = isAbsolute(rel) ? rel : join(dir, rel);
    if (!existsSync(full)) {
      missing.push(codeSpan(basename(rel)));
      continue;
    }
    const content = readFileSync(full);
    const short = basename(rel);
    if (content.length > MAX_UPLOAD_BYTES) {
      tooLarge.push(codeSpan(short));
      continue;
    }
    const name = names.has(short) ? rel.replace(/^\/+/, '').replace(/\//g, '-') : short;
    names.add(name);
    attachments.push({ name, content, mime: mimeFor(rel) });
  }
  if (tooLarge.length) parts.push(`**Videos too large to attach (over 25 MB):** ${tooLarge.join(', ')}`);
  if (missing.length) parts.push(`**Videos the run named but did not leave on disk:** ${missing.join(', ')}`);
  if (attachments.length) parts.push('**Videos of the failed specs:**');
  return { body: parts.join('\n\n'), attachments };
}

/** What the local-tests start note says. */
export interface LocalTestsStart {
  tests: number;
  minutes: number;
  branch: string;
  ticketSha: string;
  automationRef: string;
  automationSha: string;
}

/**
 * Posted on the ticket as a local run begins, by the code that starts it — a
 * forty-minute run with nothing on the ticket looks exactly like a stuck one.
 * It names both commits, so the results that follow can be tied to exactly the
 * code they ran against. Carries its own marker, because it is posted outside
 * `publishPending` and the gates must never read it as a person speaking.
 */
export function localTestsStartNote(s: LocalTestsStart): string {
  const sha7 = (sha: string): string => codeSpan(String(sha ?? '').slice(0, 7));
  return `**Local automation run started** — ${plural(s.tests, 'test')}, about ${
    Math.max(1, Math.round(Number(s.minutes) || 0))} min. `
    + `Ticket code: ${codeSpan(s.branch)} @ ${sha7(s.ticketSha)}. `
    + `Automation repo: ${codeSpan(s.automationRef)} @ ${sha7(s.automationSha)}. `
    + 'Database: fresh copy of the automation baseline. Results will be posted here.'
    + '\n\n<!-- oneshot:local-tests-start -->';
}

/**
 * What the flow and file-table renderers dropped or trimmed while drawing a
 * plan. `renderPlanMd` keeps only the markdown, so the warnings are gathered
 * here and logged once per published plan rather than once per rendering.
 */
export function planRenderWarnings(data: Record<string, unknown>): string[] {
  return [...(renderFlowMermaid(data.flow)?.warnings ?? []), ...renderFileChanges(data).warnings];
}

const SPECS: Spec[] = [
  {
    key: 'plan',
    artifact: 'plan.json',
    target: 'ticket',
    build: (data, ctx) => {
      const warnings = planRenderWarnings(data);
      if (warnings.length) {
        log.warn('publish: plan overview drew around bad or oversized entries', {
          iid: ctx.iid, warnings: warnings.slice(0, 8),
        });
      }
      // The whole plan goes inline, where GitLab renders its headings and
      // tables — a note body is markdown, an uploaded .md is served raw and
      // reaches the reader as unrendered source. The same markdown is attached
      // too, so a reviewer can download or link the plan as a file without
      // re-deriving it from the comment.
      const md = renderPlanMd(ctx.iid, ctx.journal.title, data as PlanArtifact, ctx.journal.baseSha);
      return {
        body: md,
        attachments: [{ name: `plan-${ctx.iid}.md`, content: md, mime: 'text/markdown' }],
      };
    },
  },
  {
    key: 'testcases',
    artifact: 'testcases.json',
    target: 'ticket',
    build: (data, ctx) => {
      const cases = (data.cases as TestCase[]) ?? [];
      if (!cases.length) return null;
      const high = cases.filter((c) => c.blast === 'high').length;
      return {
        body: `**Test cases** — ${cases.length} case(s), ${high} high blast radius. ` +
          'CSV attached in the team format (Test Scenario · Pre Condition · Steps). ' +
          'This one list is executed against a real browser on the branch, and is the same list the screenshots come from.',
        attachments: [{
          name: `testcases-${ctx.iid}.csv`,
          content: renderTestcasesCsv(cases),
          mime: 'text/csv',
        }],
      };
    },
  },
  {
    key: 'verify',
    artifact: 'verify.json',
    target: 'mr',
    build: (data, ctx) => {
      const results = (data.results as CaseResult[]) ?? [];
      if (!results.length) return null;
      const regressions = (data.regressions as string[]) ?? [];
      const preExisting = results.filter((r) => r.result === 'pre-existing');
      const baseShots = baseShotsFor(results, readArtifact<BaseCheck>(ctx.iid, 'base-check.json'));
      const baseShotOf = new Map(baseShots.map((s) => [s.id, s.screenshot]));
      const baseNote = (id: string): string =>
        baseShotOf.has(id) ? ` (base: ${mdText(baseShotOf.get(id) ?? '')})` : '';
      // Cases a QA reviewer ruled on at the verify-case gate (after two laps
      // through `implement` still failed). Listed for the reviewer because the
      // run completed verify on a human decision rather than on a clean pass.
      const qaDecisions = readJournal(ctx.iid)?.verifyCaseDecisions ?? [];
      const verdictWord: Record<string, string> = {
        skip: 'skipped', invalid: 'invalid — dropped',
        expected: 'expected behaviour — accepted as a pass', 'pre-existing': 'pre-existing',
        'missing-steps': "re-run with QA's corrected steps",
        confirmed: 'confirmed a real bug and sent back to `implement`',
      };
      // One row per case, not one per decision. `confirmed` is the only verdict
      // that does not settle a case, so a case can carry several decisions — two
      // confirmations and then a terminal verdict — and listing each as its own
      // line read as three separate sign-offs under a heading that says the
      // reviewer ruled "so this MR could proceed". What the reviewer of this MR
      // needs is where each case ENDED, with the rounds it cost named once.
      const lastOf = new Map<string, typeof qaDecisions[number]>();
      const lastConfirmed = new Map<string, typeof qaDecisions[number]>();
      const roundsOf = new Map<string, number>();
      for (const d of qaDecisions) {
        if (d.verdict !== 'confirmed') { lastOf.set(d.caseId, d); continue; }
        roundsOf.set(d.caseId, (roundsOf.get(d.caseId) ?? 0) + 1);
        lastConfirmed.set(d.caseId, d);
      }
      // A case still in the fix cycle has only confirmations, so its row is the
      // most recent one — the reviewer who asked for the latest round, not the
      // first, since the two need not be the same person.
      for (const [caseId, d] of lastConfirmed) if (!lastOf.has(caseId)) lastOf.set(caseId, d);
      const decisionLines = [...lastOf.values()].map((d) => {
        const rounds = roundsOf.get(d.caseId) ?? 0;
        const after = rounds && d.verdict !== 'confirmed'
          ? ` — after ${rounds} confirmed fix round(s)`
          : '';
        const round = rounds && d.verdict === 'confirmed' ? ` (round ${rounds})` : '';
        return `- ${d.caseId}: ${verdictWord[d.verdict] ?? d.verdict}${round}${after} `
          + `(QA: ${d.by})${d.issueIid ? ` → #${d.issueIid}` : ''}`;
      });
      return {
        body: `**Local verification** — ${tally(results)}.\n\n${resultTable(results)}\n\n` +
          (regressions.length
            ? `**Regressions**\n${regressions.map((r) => `- ${r}`).join('\n')}\n\n`
            : '') +
          (preExisting.length
            ? '**Pre-existing failures — not caused by this change**\n'
              + 'These fail on the base branch too, so they did not hold this MR. Please confirm '
              + 'each one is genuinely not this diff, and raise a ticket for it.\n'
              + `${preExisting.map((r) => `- ${r.id}: ${mdText(r.evidence ?? '').replace(/\s*\n\s*/g, ' ')}${baseNote(r.id)}`).join('\n')}\n\n`
            : '') +
          (qaDecisions.length
            ? '**QA decisions on still-failing cases**\n'
              + 'After two laps through `implement` these case(s) still failed and a QA reviewer ruled '
              + 'on each — either settling it so this MR could proceed, or confirming a real bug and '
              + 'sending it back for another fix:\n'
              + `${decisionLines.join('\n')}\n\n`
            : '') +
          `_Run ${ctx.runId} · executed in a real browser against the branch._`,
        // Base shots first, with room of their own, so verify's ten never crowd out the proof.
        attachments: screenshotsFrom(ctx.iid, [...baseShots, ...results], 10 + baseShots.length),
      };
    },
  },
  {
    key: 'ui-evidence',
    artifact: 'ui-evidence.json',
    target: 'mr',
    build: (data, ctx) => {
      const shots = (data.screenshots as Array<{ file: string; caption: string; caseId: string }>) ?? [];
      const observations = (data.observations as Observation[] | undefined) ?? [];
      const dir = artifactDir(ctx.iid);
      const attachments: Attachment[] = [];
      for (const s of shots.slice(0, 12)) {
        const p = join(dir, s.file);
        if (!existsSync(p)) continue;
        const content = readFileSync(p);
        if (content.length > MAX_UPLOAD_BYTES) continue;
        attachments.push({ name: s.file, content, mime: mimeFor(s.file) });
      }
      const conformance = (data.designConformance as DesignPair[] | undefined) ?? [];
      if (!attachments.length && !observations.length && !conformance.length) return null;
      const parts = [`**UI evidence** — ${[
        attachments.length ? `${attachments.length} screenshot(s)` : '',
        observations.length ? `${observations.length} measured value(s)` : '',
      ].filter(Boolean).join(' · ')}.`];
      // Measured values first: for a change a screenshot cannot show, the table
      // IS the evidence, and a reviewer should not have to scroll past pictures
      // of an unchanged page to reach it.
      if (observations.length) parts.push(observationTable(observations));
      if (attachments.length) {
        parts.push(shots.slice(0, 12)
          .map((s) => `- \`${s.file}\`${s.caseId ? ` (${s.caseId})` : ''} — ${s.caption}`).join('\n'));
      }
      if (conformance.length) parts.push(conformanceTable(conformance));
      return { body: parts.join('\n\n'), attachments };
    },
  },
  {
    /*
     * The demo webm, posted to the TICKET so a stakeholder sees the change move
     * without checking out the branch. Published from here for the same reason
     * ui-evidence is: `demo-recording` is a session, and session phases are off
     * every GitLab write tool (toolPolicy in src/conductor/phase.ts) — a model
     * that could post to the ticket could also answer a reviewer on work nobody
     * has checked. The session records the webm into artifacts/demo/ and writes
     * demo.json; this attaches it. GitLab renders an uploaded .webm inline.
     *
     * A failed capture still posts, as a note with the reason: the phase is
     * warn-on-fail, so a missing demo must leave a visible record rather than a
     * silent gap, and it never holds a change that is already verified.
     */
    key: 'demo',
    artifact: 'demo.json',
    target: 'ticket',
    build: (data, ctx) => {
      if (String(data.status ?? '') === 'failed') {
        const attempts = Number(data.attempts ?? 0);
        return {
          body: '**Demo** — no walkthrough was recorded.\n\n'
            + `> ${mdText(String(data.reason ?? 'no reason recorded').slice(0, 400))}\n\n`
            + `_${attempts || 'No'} capture attempt(s). The change was still verified, reviewed and `
            + 'evidenced — a missing demo does not hold it._',
          attachments: [],
        };
      }
      const webm = String(data.webm ?? '').trim();
      if (!webm) return null;
      const p = join(artifactDir(ctx.iid), 'demo', webm);
      if (!existsSync(p)) return null;
      const content = readFileSync(p);
      if (content.length > MAX_UPLOAD_BYTES) {
        return {
          body: '**Demo** — a walkthrough was recorded but is too large to attach '
            + `(${Math.round(content.length / (1024 * 1024))} MB, over the `
            + `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit). It is saved with the run.`,
          attachments: [],
        };
      }
      const journey = mdText(String(data.journey ?? '').slice(0, 300));
      return {
        body: '**Demo** — a short annotated walkthrough of this feature working in the app, '
          + 'so you can see the change without checking out the branch.'
          + (journey ? `\n\n> ${journey}` : ''),
        attachments: [{ name: webm, content, mime: mimeFor(webm) }],
      };
    },
  },
  {
    /*
     * The one note in this file that asks for something rather than reporting
     * something, and the only one that @mentions a person.
     *
     * WHO is `config/reviewers.json`'s `dev` list — the same list, read the same
     * way, that the plan gate names in "Only DEV may sign this off". Code review
     * and plan sign-off are the same group's job, and a second list would drift
     * from the first the first time somebody joins or leaves.
     *
     * It mentions them for real, where `reviewgate.ts:approverLine` deliberately
     * renders the same names in code spans. That is not an inconsistency: the
     * gate re-arms after every feedback round, so a live mention there would
     * notify each reviewer once per round; this note is published once per MR
     * (the `published` key is the lock), and a request nobody is told about is
     * how an MR sits open for a day.
     *
     * On the TICKET rather than the MR, because that is where this pipeline
     * already asks these people things and where they already answer.
     */
    key: 'mr-review-request',
    artifact: 'mr.json',
    target: 'ticket',
    needsMr: true,
    build: (data, ctx) => {
      const mrIid = Number(data.mrIid ?? ctx.journal.mrIid);
      const url = String(data.mrUrl ?? ctx.journal.mrUrl ?? mergeRequestUrl(mrIid));
      const title = String(data.title ?? ctx.journal.title ?? '').trim();
      const target = String(data.targetBranch ?? '').trim();

      // An empty list is a configuration mistake (config/reviewers.json says so
      // itself), but it is not a reason to swallow the MR link: the note still
      // posts, unaddressed, and the warning names the file to fix.
      const devs = reviewersConfig().dev;
      if (!devs.length) log.warn('publish: no dev reviewers in config/reviewers.json — MR review request goes unaddressed');
      const who = devs.map((u) => `@${u}`).join(' ');

      const subtitle = title
        ? `\n\n\`${title}\`${target ? ` → \`${target}\`` : ''}`
        : '';

      return {
        body: `**Merge request open** — [!${mrIid}](${url})${subtitle}\n\n`
          + `${who ? `${who} — please ` : 'Please '}review and merge this at your earliest convenience.\n\n`
          + (ctx.journal.reviewMode
            ? 'This ticket carries `Review`, so Oneshot will not merge it itself — the run is '
              + 'parked at the merge step until one of you does, and picks up from there.'
            : 'If nobody gets to it first, Oneshot merges it once its own quality gate passes — '
              + 'so this is a review request, not a merge block.')
          + '\n\nEither way the pipeline ends at the merge: nothing here deploys it.'
          + `\n\nVerification evidence is posted on the MR itself.`,
        attachments: [],
      };
    },
  },
];

// ------------------------------------------------------------------ publishing

export interface PublishCtx {
  iid: number;
  runId: string;
  journal: RunJournal;
}

async function post(spec: Spec, pub: Publication, ctx: PublishCtx): Promise<{ ok: boolean; noteId?: number }> {
  const links: string[] = [];
  for (const a of pub.attachments) {
    const up = await uploadFile(a.name, a.content, a.mime);
    if (!up.ok || !up.data) {
      log.warn(`publish: upload failed for ${a.name}`, { error: up.error?.slice(0, 120) });
      continue;
    }
    links.push((up.data as Upload).markdown);
  }

  // Every note this pipeline writes carries the marker `isMachineNote` matches.
  // Without it the review gates cannot tell their own pipeline's notes from a
  // reviewer speaking — the run-29 failure recorded in claims.ts — and this file
  // posts to the ticket the gates poll, from a token that is often a person on
  // config/reviewers.json.
  const body = `${pub.body}${links.length ? `\n\n${links.join('\n\n')}` : ''}`
    + `\n\n<!-- oneshot:publish:${spec.key} -->`;
  const res = spec.target === 'ticket'
    ? await addIssueNote(ctx.iid, body)
    : await addMergeRequestNote(ctx.journal.mrIid!, body);

  if (!res.ok) {
    log.warn(`publish: note failed for ${spec.key}`, { error: res.error?.slice(0, 120) });
    return { ok: false };
  }
  log.ok(`published ${spec.key} → ${spec.target}`, { attachments: links.length });
  // The note id lets the plan gate link its "see the plan above" note to the
  // exact comment rather than a position (data is null under DRY_RUN).
  return { ok: true, noteId: (res.data as { id: number } | null)?.id };
}

/**
 * Publish everything that is ready and not yet published.
 *
 * Never throws and never fails a phase: publishing is reporting, and a run that
 * merged correctly must not be marked blocked because GitLab refused an
 * attachment.
 */
export async function publishPending(ctx: PublishCtx): Promise<void> {
  try {
    const done = new Set(ctx.journal.published ?? []);
    const notes = { ...(ctx.journal.publishedNotes ?? {}) };
    for (const spec of SPECS) {
      if (done.has(spec.key)) continue;
      if ((spec.target === 'mr' || spec.needsMr) && !ctx.journal.mrIid) continue;

      const data = readArtifact<Record<string, unknown>>(ctx.iid, spec.artifact);
      if (!data) continue;

      const pub = spec.build(data, ctx);
      if (!pub) {
        done.add(spec.key);
        continue;
      }
      const res = await post(spec, pub, ctx);
      if (res.ok) {
        done.add(spec.key);
        if (res.noteId !== undefined) notes[spec.key] = res.noteId;
      }
    }

    const published = [...done];
    const notesChanged = JSON.stringify(notes) !== JSON.stringify(ctx.journal.publishedNotes ?? {});
    if (published.length !== (ctx.journal.published ?? []).length || notesChanged) {
      const updated = updateJournal(ctx.iid, { published, publishedNotes: notes });
      if (updated) { ctx.journal.published = published; ctx.journal.publishedNotes = notes; }
    }
  } catch (err) {
    log.warn('publish pass failed', { error: (err as Error).message.slice(0, 160) });
  }
}
