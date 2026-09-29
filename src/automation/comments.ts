/**
 * What the Ready For Automation mode says on a ticket, and the checks a
 * session's output passes before any of it is said.
 *
 * Every body here is rendered by code from a saved artifact, never taken from a
 * session verbatim. That is what makes three promises cheap to keep:
 *
 * 1. Model text cannot break the note. Every model-written string reaches a
 *    table through `tableCell` and reaches prose through `mdText` (both in
 *    src/lib/gitlabmd.ts), so a scenario holding `|`, a newline or `<title>`
 *    renders as text. The same escaping turns a `<!-- oneshot:` a model wrote
 *    into `&lt;!-- oneshot:`, so a case can never forge one of the markers below.
 *
 * 2. Nothing is posted twice. Each body ends with its marker on its own line,
 *    and the runner looks for that marker in the ticket's newest notes before
 *    it posts, so a crash between the post and the journal write adopts the
 *    note instead of repeating it. Every marker starts `<!-- oneshot:`, which is
 *    what `isMachineNote` (src/lib/claims.ts) keys on: the Loop's gates, its
 *    `fetchTicket` and this mode's own approval tally all skip these notes.
 *
 * 3. Nothing secret is published. `sanitizeArtifact` runs every model-written
 *    string through the run report's `redact` before a version is saved, so
 *    the note, the CSV and the sheet all carry the same cleaned text, and an
 *    artifact holding a private key is refused outright.
 *
 * Pure apart from `redact` reading this desk's pinned test logins, so the
 * templates are tested as strings.
 */
import { createHash } from 'node:crypto';
import type { IssueNote } from '../lib/gitlab.js';
import { codeSpan, mdText, tableCell } from '../lib/gitlabmd.js';
import { csvCell } from '../lib/publish.js';
import { redact } from '../lib/report.js';
import type { MrRef, Readiness } from './readiness.js';
import { moduleDisplayName, normaliseModule, plainText } from './sheetlayout.js';
import type { AutomationArtifact, AutomationCase, Automatable } from './types.js';

// ------------------------------------------------------------------- markers

export type MarkerKind = 'not-ready' | 'cases' | 'failed' | 'nochange' | 'done' | 'sheet-failed';

/**
 * The hidden line that makes a note this mode's own. `detail` is what tells two
 * notes of one kind apart: the readiness fingerprint, `v<N>:<hash>` for a
 * version, the failure class. It never holds whitespace or `-->`.
 */
export function marker(kind: MarkerKind, detail?: string): string {
  return `<!-- oneshot:automation:${kind}${detail ? `:${detail}` : ''} -->`;
}

/**
 * A marker at the START of a line. Every body here puts it there, and a person
 * quoting one of these notes puts `> ` in front of it, so a quoted copy in a
 * human reply is never mistaken for the note itself.
 */
const MARKER_RE = /^[ \t]*<!--\s*oneshot:automation:([a-z]+(?:-[a-z]+)*)(?::(\S*?))?\s*-->/gm;

/**
 * The newest note carrying a `kind` marker whose detail starts with
 * `detailPrefix` (any detail when it is omitted). The prefix is how a caller
 * asks for "any v3 note" (`'v3:'`) without knowing the hash it was posted
 * with; `'v1:'` does not match `v10:`.
 *
 * Newest by id rather than by position, so it does not matter which way the
 * caller's list is sorted. GitLab's own system notes are skipped.
 */
export function findMarker(notes: IssueNote[], kind: MarkerKind, detailPrefix?: string): IssueNote | null {
  let best: IssueNote | null = null;
  for (const n of notes) {
    if (n.system) continue;
    const hit = [...(n.body ?? '').matchAll(MARKER_RE)].some((m) =>
      m[1] === kind && (detailPrefix === undefined || (m[2] ?? '').startsWith(detailPrefix)));
    if (hit && (!best || n.id > best.id)) best = n;
  }
  return best;
}

// ------------------------------------------------------------- the case list

/**
 * The most cases one version may hold. Above this a list is not a test plan a
 * person can review in one sitting, and the body starts to approach GitLab's
 * 1,000,000-character note limit. The schema says so as advice; this is where
 * it is enforced, as a charged, retryable failure.
 */
export const MAX_CASES = 60;

const ID_RE = /^TC-\d{2,}$/;
const AUTOMATABLE: ReadonlySet<string> = new Set<Automatable>(['yes', 'partly', 'no']);

/** Field order, as the note, the CSV and the sheet all show it. */
const FIELDS: ReadonlyArray<keyof AutomationCase> =
  ['id', 'scenario', 'precondition', 'steps', 'expected', 'automatable', 'reason'];

/** How a changed field is named in the "What changed" list, in the note's own column words. */
const FIELD_LABEL: Record<keyof AutomationCase, string> = {
  id: 'id',
  scenario: 'scenario',
  precondition: 'pre-condition',
  steps: 'steps',
  expected: 'expected result',
  automatable: 'automatable',
  reason: 'reason',
};

export interface CaseDiff {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; fields: Array<keyof AutomationCase> }>;
}

/** Whitespace-insensitive text, so a re-wrapped line is not reported as a change nobody asked for. */
function squash(v: unknown): string {
  const s = Array.isArray(v) ? v.map((x) => String(x ?? '')).join('\u0000') : String(v ?? '');
  return s.replace(/[^\S\u0000]+/g, ' ').trim();
}

/**
 * What a revision did, computed rather than taken from the session's own
 * account. `changes` (the session's notes) is shown too, but a reviewer
 * checking "did it touch anything else" is answered by this list, which
 * cannot leave a change out.
 *
 * Matched by id, which is the contract REVISE works under: a changed case keeps
 * its id. `added` and `changed` follow the new list's order, `removed` the old.
 */
export function diffCases(prev: AutomationCase[], next: AutomationCase[]): CaseDiff {
  const before = new Map(prev.map((c) => [c.id, c]));
  const after = new Set(next.map((c) => c.id));
  const diff: CaseDiff = { added: [], removed: [], changed: [] };
  for (const c of next) {
    const old = before.get(c.id);
    if (!old) {
      diff.added.push(c.id);
      continue;
    }
    const fields = FIELDS.filter((f) => f !== 'id' && squash(old[f]) !== squash(c[f]));
    if (fields.length) diff.changed.push({ id: c.id, fields });
  }
  for (const c of prev) if (!after.has(c.id)) diff.removed.push(c.id);
  return diff;
}

export function isEmptyDiff(d: CaseDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length;
}

/** Objects with their keys sorted, recursively, so the hash is the content and not the key order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/**
 * sha256 of the canonical JSON, first 12 hex. It goes into the version's
 * marker, so a posted note can be matched to the saved version it came from.
 */
export function casesHash(cases: AutomationCase[]): string {
  return createHash('sha256').update(JSON.stringify(canonical(cases))).digest('hex').slice(0, 12);
}

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * null when the list is usable; otherwise the reason, in words fit for the
 * stuck note ("the list has 61 cases, more than the 60 allowed").
 *
 * `everIds` holds the ids earlier versions used that the version being revised
 * no longer carries (the REMOVED ids), each with the scenario it had. A case
 * may not take one of those ids for a different behaviour: QA refers to cases
 * by id across versions, and "TC-05" meaning one thing in v1 and another in v3
 * is how an approval lands on the wrong case. The same case coming back under
 * its old id, with its old scenario, is not a reuse and passes.
 *
 * Scenarios are compared ignoring case and spacing. Should a caller pass every
 * id ever used, kept cases still pass as long as their scenario is unchanged.
 */
export function validateCases(cases: AutomationCase[], everIds?: Map<string, string>): string | null {
  if (!Array.isArray(cases) || cases.length === 0) return 'the list has no cases';
  if (cases.length > MAX_CASES) return `the list has ${cases.length} cases, more than the ${MAX_CASES} allowed`;
  const seen = new Set<string>();
  for (const [i, c] of cases.entries()) {
    if (!c || typeof c !== 'object') return `case ${i + 1} is not a case`;
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      return `case ${i + 1} has the id ${JSON.stringify(c.id)}; ids look like TC-01`;
    }
    if (seen.has(c.id)) return `${c.id} is used by more than one case`;
    seen.add(c.id);
    if (!filled(c.scenario)) return `${c.id} has no scenario`;
    if (typeof c.precondition !== 'string') return `${c.id} has no pre-condition field (use '' for none)`;
    if (!Array.isArray(c.steps) || !c.steps.length) return `${c.id} has no steps`;
    if (!c.steps.every(filled)) return `${c.id} has an empty step`;
    if (!filled(c.expected)) return `${c.id} has no expected result`;
    if (!AUTOMATABLE.has(c.automatable)) return `${c.id} has automatable ${JSON.stringify(c.automatable)}; it must be yes, partly or no`;
    if (!filled(c.reason)) return `${c.id} has an empty reason`;
    const was = everIds?.get(c.id);
    if (was !== undefined && squash(was).toLowerCase() !== squash(c.scenario).toLowerCase()) {
      return `${c.id} was removed earlier (it was "${was}") and is reused for a different case; a new case takes the next unused id`;
    }
  }
  return null;
}

/**
 * validateCases, plus a module the sheet can file the cases under. A module
 * that normalises to nothing (`Test Cases`, `-`) would match every blank
 * column-A cell on the tracker, so it is refused here, before a version exists.
 *
 * The name is read the way a tab title is (`moduleDisplayName` first), because
 * `normaliseModule` alone keeps the words of a bare `Test Cases` and would let
 * it through as the module "testcase".
 */
export function validateArtifact(a: AutomationArtifact, everIds?: Map<string, string>): string | null {
  if (!a || typeof a !== 'object') return 'the output is not an object';
  const cases = validateCases(a.cases, everIds);
  if (cases) return cases;
  if (typeof a.module !== 'string' || !normaliseModule(moduleDisplayName(a.module))) {
    return `the module ${JSON.stringify(a.module)} does not name a module`;
  }
  return null;
}

/**
 * A PEM private key's opening line. `redact` works line by line on the shape
 * around a value, and a key is forty lines of base64 with no name beside it,
 * so it is the one secret those rules cannot blank out. Refusing is the only
 * safe answer.
 */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Every model-written string (summary, blocked, module, each case field and
 * step, changes, sources) through report.ts `redact` BEFORE the artifact is
 * saved, so the note, the CSV and the sheet all carry the same cleaned text.
 * Refuses (`{ refused }`) when any string holds a private-key block, which the
 * one-line redaction rules cannot cover.
 *
 * The session has no file tools, so a key here would have come from ticket or
 * MR text. It is refused all the same: the cases note is posted before any
 * person reads it.
 *
 * `automatable` is an enum and is kept as it is. A value `redact` changes (a
 * step reading `password: Welcome123`) is changed everywhere at once; the skill
 * tells the session to name the account instead of writing a credential.
 */
export function sanitizeArtifact(a: AutomationArtifact): { artifact: AutomationArtifact } | { refused: string } {
  const texts: string[] = [
    a.summary, a.blocked ?? '', a.module, ...(a.changes ?? []), ...(a.sources ?? []),
    ...(a.cases ?? []).flatMap((c) => [c.id, c.scenario, c.precondition, c.expected, c.reason, ...(c.steps ?? [])]),
  ].filter((s): s is string => typeof s === 'string');
  if (texts.some((s) => PRIVATE_KEY_RE.test(s))) return { refused: 'the output contained a private key' };

  const r = (s: unknown): string => (typeof s === 'string' ? redact(s) : '');
  const artifact: AutomationArtifact = {
    summary: r(a.summary),
    module: r(a.module),
    cases: (a.cases ?? []).map((c) => ({
      id: r(c.id),
      scenario: r(c.scenario),
      precondition: r(c.precondition),
      steps: (c.steps ?? []).map(r),
      expected: r(c.expected),
      automatable: c.automatable,
      reason: r(c.reason),
    })),
    changes: (a.changes ?? []).map(r),
    sources: (a.sources ?? []).map(r),
  };
  if (a.blocked !== undefined) artifact.blocked = typeof a.blocked === 'string' ? redact(a.blocked) : a.blocked;
  return { artifact };
}

// ----------------------------------------------------------------------- CSV

/** The sheet's own seven columns, in its own words. */
const CSV_HEADERS = ['ID', 'Test Scenario', 'Pre Condition', 'Steps', 'Expected Result', 'Automatable', 'Reason'] as const;

/**
 * A spreadsheet reads a cell starting with = + - @ (or a tab or carriage
 * return, which some strip first) as a formula, and a formula in a file QA
 * opens is a formula QA runs. A leading `'` makes it text in Excel and Sheets.
 */
function defuse(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * header: ID,Test Scenario,Pre Condition,Steps,Expected Result,Automatable,Reason. Starts with a UTF-8
 * BOM (Excel then shows → and — correctly). A cell starting with = + - @ or a tab is prefixed with '
 * (CSV formula injection). The sheet itself is written with stringValue, which never evaluates.
 *
 * Steps are numbered and kept on their own lines inside one quoted cell, the
 * way the team's sheet holds them. Case text is `plainText`, as in the sheet:
 * the CSV is opened in a spreadsheet, where `**Save**` shows its asterisks.
 * The note's table keeps the emphasis, because GitLab renders it.
 */
export function renderCasesCsv(cases: AutomationCase[]): string {
  const head = CSV_HEADERS.map(csvCell).join(',');
  const rows = cases.map((c) => [
    c.id,
    plainText(c.scenario),
    plainText(c.precondition),
    (c.steps ?? []).map((s, i) => `${i + 1}. ${plainText(s)}`).join('\n'),
    plainText(c.expected),
    c.automatable,
    plainText(c.reason),
  ].map((v) => csvCell(defuse(String(v ?? '')))).join(','));
  return `﻿${[head, ...rows].join('\n')}`;
}

// ------------------------------------------------------------------ helpers

const at = (user: string): string => `@${user}`;

/** "a", "a and b", "a, b and c". */
function listOf(items: string[], word: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** Link text: prose-escaped, with the brackets a tab title like `Team Reviews [Latest]` carries. */
function linkText(s: string): string {
  return mdText(s).replace(/[[\]]/g, '\\$&');
}

/** A URL safe inside `(…)`. */
function linkUrl(s: string): string {
  return s.replace(/[()\s]/g, (ch) => encodeURIComponent(ch));
}

function mrRef(m: MrRef): string {
  return `!${m.iid} (${codeSpan(m.source)} → ${codeSpan(m.target)})`;
}

const ICON: Record<Automatable, string> = { yes: '✅', partly: '🟡', no: '⛔' };

/** A sentence from model text, without the doubled full stop the template's own `.` would add. */
function clause(s: string): string {
  return mdText(s.trim().replace(/[.\s]+$/, ''));
}

// ---------------------------------------------------------------- not ready

/**
 * §5.1. Posted once per fingerprint, labels untouched. The reasons' `text` and
 * `fix` come from the readiness hook, which reads the same config labels, so
 * they already name `deployed` where it matters; `trigger` is named here
 * because this body opens with it.
 */
export function notReadyBody(r: Readiness, o: { recheckMinutes: number; trigger: string; deployed: string }): string {
  const reasons = r.reasons.length
    ? r.reasons.map((x) => `- ❌ **${clause(x.text)}**\\\n  Fix: ${mdText(x.fix.trim())}`).join('\n')
    : '- ❌ **The readiness check gave no reason.**';
  const warnings = r.warnings.length ? `\n\n⚠️ ${r.warnings.map((w) => mdText(w)).join('; ')}` : '';
  return `**Automation test cases: not started yet**

This ticket carries ${codeSpan(o.trigger)}, but oneshot cannot write its automation test cases yet:

${reasons}${warnings}

You don't need to reply to this comment. Oneshot checks again whenever this ticket changes, and at least every ${o.recheckMinutes} minutes. It never posts the same message twice.

${marker('not-ready', r.fingerprint ?? undefined)}`;
}

// ------------------------------------------------------------- a version

export interface VersionView {
  iid: number; v: number; module: string; moduleTab: string; moduleTabIsNew: boolean;
  cases: AutomationCase[]; merged: MrRef[]; open: MrRef[]; approvers: string[];
  csvMarkdown: string | null;            // uploadFile().markdown; null → a line saying the CSV could not be attached
  diff?: CaseDiff; notes?: string[]; feedbackAuthors?: string[]; ignoredApproval?: boolean;
  /** Approver notes that arrived while this version was being written (id > watermark at post time). */
  during?: { changeAuthors: string[]; staleApprovers: string[] };
  lostHistory?: boolean; hash: string;
  /** The label an approval earns, as config/project.json names it. Defaults to `Automation Done`. */
  doneLabel?: string;
}

/**
 * GitLab rejects a note body over 1,000,000 characters, and a 400 on the cases
 * note would repeat every tick. The margin leaves room for the head, the
 * instructions and the cut line.
 */
export const NOTE_BODY_LIMIT = 900_000;

const TABLE_HEAD = '| ID | Scenario | Pre-condition | Steps | Expected | Automatable | Reason |\n'
  + '| --- | --- | --- | --- | --- | --- | --- |';

function caseRow(c: AutomationCase): string {
  const steps = (c.steps ?? []).map((s, i) => `${i + 1}. ${tableCell(s)}`).join('<br>');
  return `| **${tableCell(c.id)}** | ${tableCell(c.scenario)} | ${tableCell(c.precondition) || '—'} | `
    + `${steps || '—'} | ${tableCell(c.expected)} | ${ICON[c.automatable] ?? ''} ${c.automatable} | ${tableCell(c.reason)} |`;
}

function countLine(cases: AutomationCase[]): string {
  const n = (a: Automatable): number => cases.filter((c) => c.automatable === a).length;
  return `${cases.length} cases: ${n('yes')} automatable, ${n('partly')} partly, ${n('no')} not automatable.`;
}

function whatChanged(view: VersionView): string {
  const notes = view.notes ?? [];
  if (view.v <= 1 || (!view.diff && !notes.length)) return '';
  const byId = new Map(view.cases.map((c) => [c.id, c]));
  const lines: string[] = [];
  for (const id of view.diff?.added ?? []) {
    lines.push(`- Added **${mdText(id)}**: ${mdText(byId.get(id)?.scenario ?? '')}`);
  }
  for (const ch of view.diff?.changed ?? []) {
    lines.push(`- Changed **${mdText(ch.id)}**: ${ch.fields.map((f) => FIELD_LABEL[f]).join(', ')}`);
  }
  for (const id of view.diff?.removed ?? []) lines.push(`- Removed **${mdText(id)}**`);
  for (const n of notes) lines.push(`- Note: ${mdText(n)}`);
  if (!lines.length) lines.push('- No case changed.');
  const by = view.feedbackAuthors?.length ? ` (requested by ${view.feedbackAuthors.map(at).join(', ')})` : '';
  return `**What changed since v${view.v - 1}**${by}\n${lines.join('\n')}`;
}

/** The lines about this round's own history. Separate paragraphs: a line straight after a list joins its last item. */
function roundLines(view: VersionView): string[] {
  const out: string[] = [];
  if (view.ignoredApproval) {
    out.push('_An `approved` in the same round was not applied, because change requests came with it. '
      + 'Approve this version when it looks right._');
  }
  const changeAuthors = view.during?.changeAuthors ?? [];
  if (changeAuthors.length) {
    out.push(`_Comments from ${listOf(changeAuthors.map(at))} posted while v${view.v} was being written are `
      + `not in this version. They will be applied in v${view.v + 1}._`);
  }
  for (const who of view.during?.staleApprovers ?? []) {
    out.push(`_${at(who)}'s \`approved\` came in while v${view.v} was being written, so it applied to `
      + `v${view.v - 1}. Please approve v${view.v} if it looks right._`);
  }
  return out;
}

function casesHead(view: VersionView): string {
  const merged = view.merged.length
    ? `Written from the merged change${view.merged.length > 1 ? 's' : ''} ${view.merged.map(mrRef).join(', ')}.`
    : 'Written from the ticket: no merged change was recorded.';
  const parts = [
    `**Automation test cases: v${view.v}** for #${view.iid} · module **${mdText(view.module)}**`,
    `${merged} ${countLine(view.cases)}`,
  ];
  if (view.open.length) {
    const ids = listOf(view.open.map((m) => `!${m.iid}`));
    parts.push(view.open.length > 1
      ? `⚠️ Ignored: ${ids} are still open, so they are not what shipped.`
      : `⚠️ Ignored: ${ids} is still open, so it is not what shipped.`);
  }
  if (view.lostHistory) {
    parts.push('_The earlier review state for this ticket was lost on the oneshot side, so this list was written fresh._');
  }
  const changed = whatChanged(view);
  if (changed) parts.push(changed);
  parts.push(...roundLines(view));
  return parts.join('\n\n');
}

function casesTail(view: VersionView): string {
  const who = view.approvers.map(at);
  const tab = `${view.moduleTabIsNew ? 'new tab' : 'tab'} ${codeSpan(view.moduleTab)}`;
  const done = codeSpan(view.doneLabel ?? 'Automation Done');
  const ask = who.length ? `${who.join(' ')}, please review v${view.v}.` : `Please review v${view.v}.`;
  const only = who.length
    ? `Only comments from ${listOf(who)} posted after this one count.`
    : 'Only comments from the QA approvers in config/reviewers.json posted after this one count.';
  return `📎 ${view.csvMarkdown ?? '_The CSV could not be attached._'}

---
${ask}
- **Approve:** comment the single word \`approved\`. The cases are then written to the test-case sheet (${tab}), and this ticket gets ${done}.
- **Request changes:** comment what to change in plain words and name cases by id, for example "TC-03 should expect a 403", "drop TC-07", or "add a case for an expired session". Oneshot writes v${view.v + 1} with only those changes and posts it here. Every other case keeps its text and id.

${only} If the same round has both a change request and \`approved\`, the change request wins.

${marker('cases', `v${view.v}:${view.hash}`)}`;
}

/**
 * The line that replaces the rows a very long list could not fit. The CSV is
 * the complete list, so the note points there rather than dropping rows
 * silently.
 */
function cutLine(kept: number, total: number, lastId: string | null, csv: boolean): string {
  const where = lastId ? `stops at **${lastId}** (${kept} of ${total} cases)` : `has none of the ${total} cases`;
  return `_The table ${where}: GitLab cannot take a longer comment. ${csv
    ? 'The attached CSV has every case.'
    : 'The CSV could not be attached either, so the remaining cases are only in oneshot\'s saved copy of this version.'}_`;
}

/** Room kept for the cut line itself, whatever the ids and counts turn out to be. */
const CUT_RESERVE = 400;

/**
 * §5.2. Over NOTE_BODY_LIMIT the table is cut after the last row that fits,
 * with a line saying the rest is in the CSV. Everything around the table (the
 * change list, how to approve, the marker) is always kept whole: without the
 * marker the note would be posted again, and without the instructions nobody
 * could approve it.
 */
export function casesBody(view: VersionView): string {
  const head = casesHead(view);
  const tail = casesTail(view);
  const rows = view.cases.map(caseRow);
  const assemble = (body: string[], cut: string): string =>
    `${head}\n\n${TABLE_HEAD}\n${body.join('\n')}${cut ? `\n\n${cut}` : ''}\n\n${tail}`;
  const full = assemble(rows, '');
  if (full.length <= NOTE_BODY_LIMIT) return full;

  let room = NOTE_BODY_LIMIT - assemble([], '').length - CUT_RESERVE;
  const kept: string[] = [];
  for (const row of rows) {
    if (row.length + 1 > room) break;
    kept.push(row);
    room -= row.length + 1;
  }
  const lastId = kept.length ? (view.cases[kept.length - 1]?.id ?? null) : null;
  return assemble(kept, cutLine(kept.length, rows.length, lastId, view.csvMarkdown !== null));
}

// ------------------------------------------------------------- the others

/**
 * §5.3. A REVISE that changed nothing, or a round that held only
 * near-approvals ("Approved.", "approved ✅") and so spent no session.
 * `maxNoteId` is the round's highest note id, which becomes the marker's
 * detail; without it the marker carries none.
 */
export function noChangeBody(o: {
  v: number; authors: string[]; notes: string[]; nearApproval: boolean; maxNoteId?: number;
}): string {
  const whose = o.authors.length === 1
    ? `${at(o.authors[0]!)}'s comment`
    : o.authors.length
      ? `the comments from ${listOf(o.authors.map(at))}`
      : 'the latest comment';
  const parts = [`**Automation test cases: no change made** to v${o.v} for ${whose}.`];
  if (o.notes.length) parts.push(o.notes.map((n) => `- ${mdText(n)}`).join('\n'));
  if (o.nearApproval) {
    parts.push('Oneshot approves only on the single word `approved`, with nothing else in the comment, so '
      + 'that a comment asking for changes can never approve by accident.');
  }
  parts.push(`To approve v${o.v}, comment the single word \`approved\`.`);
  parts.push(marker('nochange', o.maxNoteId !== undefined ? String(o.maxNoteId) : undefined));
  return parts.join('\n\n');
}

/** §5.4. Authoring failed twice. Any QA approver's comment releases it. */
export function stuckBody(reason: string, fp: string, approvers: string[]): string {
  const who = approvers.length ? `${listOf(approvers.map(at), 'or')}: comment` : 'A QA approver can comment';
  return `**Automation test cases: could not be written**

Oneshot tried twice and could not produce the test cases: ${clause(reason)}.
${who} anything on this ticket (for example "retry") to have it try again.

${marker('failed', fp)}`;
}

/** §5.7. Approved, but the sheet write failed in a way that needs a person, or has lasted an hour. */
export function sheetFailedBody(o: { v: number; kind: string; reason: string; action: string }): string {
  return `**Automation test cases: approved, but not written to the sheet yet**

v${o.v} is approved, but writing it to the test-case sheet failed: ${clause(o.reason)}.
${mdText(o.action.trim())}
Oneshot keeps retrying by itself; labels stay as they are until the write succeeds.

${marker('sheet-failed', o.kind)}`;
}

/**
 * §5.5. The last note: where the cases went, and the label edit that closed the
 * loop — `removed`/`added` are the edit runner.ts made (doneLabelEdit), so the
 * note names exactly what changed on the board.
 */
export function doneBody(o: {
  v: number; count: number; approvedBy: string; removed: string[]; added: string[];
  sheet: { moduleTab: string; blockRange: string; blockLink: string; trackerTab: string; trackerRow: number; trackerLink: string; automationStatus: string };
}): string {
  const s = o.sheet;
  // A DRY_RUN approval is recorded as 'dry-run'; there is nobody to mention.
  const by = o.approvedBy === 'dry-run' ? 'approved automatically (dry run)' : `approved by ${at(o.approvedBy)}`;
  return `**Automation test cases: done** ✅

v${o.v} (${o.count} cases) was ${by} and written to the test-case sheet:
- Cases: [${linkText(s.moduleTab)}, ${linkText(s.blockRange)}](${linkUrl(s.blockLink)})
- Tracker: [${linkText(s.trackerTab)}, row ${s.trackerRow}](${linkUrl(s.trackerLink)}). Test Case Status is **Done**, Automation Status is **${mdText(s.automationStatus)}**.

Labels: removed ${listOf(o.removed.map(codeSpan))}, added ${listOf(o.added.map(codeSpan))}.

${marker('done')}`;
}
