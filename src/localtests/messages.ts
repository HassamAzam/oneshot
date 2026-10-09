/**
 * What the local automation tests mode says on a ticket.
 *
 * The mode runs after the ticket's change is merged and talks to QA through
 * the ticket alone, so every step it takes is one comment rendered here: the
 * tests it found (or that it found none), what a re-check turned up, the record
 * of going on without tests, the results, a run that could not happen, and
 * tests that could not be chosen at all.
 *
 * Four rules shape every body:
 *
 * 1. The headline comes first, in bold, and says where things stand. These
 *    notes reach people as notifications, and the first line is often all that
 *    is read.
 *
 * 2. Model text cannot break a note. A spec's `why` reaches a table through
 *    `tableCell` and prose through `mdText` (src/lib/gitlabmd.ts), folded onto
 *    one line and clipped, so a `|`, a newline or a `<!-- oneshot:` it holds
 *    renders as text and can never forge one of the markers below.
 *
 * 3. Every body ends with its own `<!-- oneshot:local-tests:<kind> -->` marker.
 *    `isMachineNote` (src/lib/claims.ts) keys on it, so the mode never reads
 *    one of its own notes as QA replying, and the runner can find a note it
 *    posted before a crash instead of posting it twice.
 *
 * 4. QA are @mentioned for real, never inside a code span, on the notes that
 *    ask them something: the mention is how they learn a decision is waiting.
 *    The review gates write `@user` in a code span on purpose, to stop a
 *    notification per round; here the ask IS the point of the note.
 *
 * Every builder returns `{ body, attachments }`, attachments empty where there
 * is nothing to attach, so the runner posts all of them one way. Reads config
 * (the label names, the automation ref) and the patch file, nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { localTestsConfig } from '../lib/config.js';
import { codeSpan, mdText, tableCell } from '../lib/gitlabmd.js';
import { MAX_UPLOAD_BYTES, localTestsReportNote, mimeFor, type PublishCtx } from '../lib/publish.js';
import type { LocalTestsRun, LocalTestsScope } from '../phases/types.js';

export interface Attachment { name: string; content: Buffer | string; mime: string }

export interface LocalTestsNote {
  body: string;
  attachments: Attachment[];
}

/** One of the ticket's own merged MRs the list was chosen for: its iid, and its merge (or squash) commit. */
export interface ScopedMr { iid: number; sha: string }

/** What the found and not-found notes need besides the scope. */
export interface LocalTestsNoteInfo {
  /** The workstream-automation commit the list was chosen against. */
  automationSha: string;
  /** The merge commit of the ticket's MR: the code the tests run against. */
  mergeSha: string;
  mrIid?: number;
  /**
   * Every one of the ticket's own MRs merged into the base that the list was
   * chosen for, oldest first, the tested one (`mrIid`, `mergeSha`) among them.
   * Absent or only the tested one: the note names that MR alone, as before.
   */
  mrs?: ScopedMr[];
  /** The QA reviewers to @mention (config/reviewers.json `qa`). */
  qa: string[];
  /** The MR's title, the plainest "what changed". Absent, the scope's `reason` says it. */
  mrTitle?: string;
  /** The scope's saved temporary changes (ScopeInputs.patchFile). Attached when the file is there. */
  patchFile?: string;
}

/** What the quick re-check (or a `disapproved: added …` reply) produced. */
export interface LocalTestsRecheck {
  /** The spec files QA is now asked to approve, optionally with what each checks. Empty: still none. */
  found: Array<string | { file: string; why?: string }>;
  automationSha: string;
  /** Paths an `added` reply named that are not on the automation ref. */
  unknown?: string[];
  /** The found list priced by the analysis script's `estimate`, when the caller ran it. */
  estimatedMinutes?: number;
}

// ------------------------------------------------------------------- markers

export type LocalTestsMarkerKind =
  | 'found' | 'not-found' | 'recheck' | 'approved-without-tests' | 'results' | 'setup-error' | 'stuck';

/** The hidden last line that makes a note this mode's own, one kind per builder. */
export function localTestsMarker(kind: LocalTestsMarkerKind): string {
  return `<!-- oneshot:local-tests:${kind} -->`;
}

// ------------------------------------------------------------------- helpers

/** Specs shown in the table; the rest of a long list sits in a collapsed block under it. */
const TABLE_ROWS = 10;

/** A spec's "what it checks" is clipped here: one short line, not the session's paragraph. */
const WHY_CHARS = 120;

/** The session's own account, folded away under the list, is clipped here. */
const SUMMARY_CHARS = 1500;

/** Why the tests could not be chosen is clipped here: a session's failure can be a whole stack. */
const STUCK_REASON_CHARS = 600;

/** Folded onto one line, unescaped: for a table cell, which `tableCell` escapes. */
function flat(v: unknown): string {
  return String(v ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * One line of prose, escaped, without the full stop the template adds — the
 * same rule as publish.ts's `clause`, which that file keeps private.
 */
function clause(v: unknown): string {
  return mdText(flat(v)).replace(/[.\s]+$/, '');
}

/** Inside `*…*`, where a stray asterisk would end the emphasis early. */
function italic(v: unknown): string {
  return `*${clause(v).replace(/\*/g, '\\*')}*`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const at = (user: string): string => `@${user}`;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const sha7 = (sha: string): string => codeSpan(String(sha ?? '').trim().slice(0, 7) || 'unknown');

function listOf<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : [];
}

/** A scope as the artifact holds it, or the typed object the runner has: either reads the same. */
type ScopeLike = Partial<LocalTestsScope> | Record<string, unknown> | null | undefined;

function scopeOf(scope: ScopeLike): Partial<LocalTestsScope> {
  return (scope ?? {}) as Partial<LocalTestsScope>;
}

/**
 * The mode's three labels, as config/project.json names them. The fallbacks
 * are those names as shipped; a desk with a label left empty has the mode
 * switched off and posts none of these notes.
 */
function labels(): { trigger: string; running: string; done: string } {
  const l = localTestsConfig().labels;
  return {
    trigger: l?.trigger || 'Ready for Automation Testing',
    running: l?.running || 'Running TestCases Locally',
    done: l?.done || 'Automation Testing Done',
  };
}

/** The automation ref as people say it: `origin/master` is "master". */
function automationRefName(): string {
  return localTestsConfig().automationRef.replace(/^origin\//, '') || 'master';
}

type ChangeInfo = Pick<LocalTestsNoteInfo, 'mergeSha' | 'mrIid' | 'mrTitle' | 'mrs'>;

/**
 * The ticket's other merged MRs the list was also chosen for, oldest first:
 * every entry of `mrs` but the tested one, each named once.
 */
function earlierMrs(info: ChangeInfo): ScopedMr[] {
  const tested = String(info.mergeSha ?? '').trim();
  const seen = new Set<number>(info.mrIid ? [info.mrIid] : []);
  const out: ScopedMr[] = [];
  for (const m of listOf<{ iid?: unknown; sha?: unknown }>(info.mrs)) {
    const iid = Number(m.iid);
    const sha = String(m.sha ?? '').trim();
    if (!Number.isInteger(iid) || iid <= 0 || seen.has(iid) || (sha && sha === tested)) continue;
    seen.add(iid);
    out.push({ iid, sha });
  }
  return out;
}

/**
 * What changed, in one line: the tested MR and its merge commit. When the list
 * was chosen for several of the ticket's merged MRs, the earlier ones are
 * named after it, so QA can see every change the list stands for.
 */
function whatChanged(s: Partial<LocalTestsScope>, info: ChangeInfo): string {
  const where = `${info.mrIid ? `MR !${info.mrIid}` : 'the MR'}, merged as ${sha7(info.mergeSha)}`;
  const what = clause(info.mrTitle) || clause(s.reason);
  const head = `**What changed:** ${what ? `${what} (${where}).` : `the change in ${where}.`}`;
  const earlier = earlierMrs(info);
  if (!earlier.length) return head;
  const named = earlier.map((m) => `!${m.iid}${m.sha ? ` (merged as ${sha7(m.sha)})` : ''}`).join(', ');
  return `${head} Also checked: this ticket's earlier merged ${earlier.length === 1 ? 'MR' : 'MRs'} ${named}.`;
}

// --------------------------------------------------------------- the list

type Mark = 'new' | 'checks' | 'health';

const MARK: Record<Mark, string> = { new: '🆕', checks: '✔️', health: '🩺' };

const LEGEND: Record<Mark, string> = {
  new: '🆕 new temporary test, for this run only',
  checks: '✔️ existing test that checks the change',
  health: '🩺 health check of the module',
};

/**
 * How the scope marks a health-check spec: its `why` starts `Health check:`
 * (the prompt asks for exactly that). `smoke` is accepted too, the word the
 * analysis script tags those specs with. A dash counts only with a space after
 * it, so "smoke-tagged spec that…" is not read as the prefix.
 */
const HEALTH_RE = /^\s*(?:health[\s-]*checks?|smoke(?:\s+tests?)?)\s*(?::|[—–-]\s)\s*/i;

interface Row { mark: Mark; file: string; what: string }

/**
 * One row per spec file, de-duplicated: the new temporary tests first, then the
 * existing tests that check the change, then the health checks. A spec the
 * scope created is new whatever its `why` says.
 */
function rowsOf(s: Partial<LocalTestsScope>): Row[] {
  const created = new Set(listOf<{ file?: unknown; kind?: unknown }>(s.edits)
    .filter((e) => e.kind === 'add').map((e) => String(e.file ?? '').trim()));
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const spec of listOf<{ file?: unknown; why?: unknown }>(s.specs)) {
    const file = String(spec.file ?? '').trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const why = flat(spec.why);
    const health = HEALTH_RE.test(why);
    const bare = why.replace(HEALTH_RE, '');
    const what = health ? `${bare.charAt(0).toUpperCase()}${bare.slice(1)}` : bare;
    rows.push({ mark: created.has(file) ? 'new' : health ? 'health' : 'checks', file, what });
  }
  const order: Mark[] = ['new', 'checks', 'health'];
  return order.flatMap((m) => rows.filter((r) => r.mark === m));
}

const TABLE_HEAD = '| | Test | What it checks |\n|---|---|---|';

function row(r: Row): string {
  const what = clip(r.what.replace(/[.\s]+$/, ''), WHY_CHARS);
  return `| ${MARK[r.mark]} | ${tableCell(codeSpan(r.file))} | ${what ? tableCell(what) : '—'} |`;
}

/** The first TABLE_ROWS rows as the table; any beyond stay one click away, never dropped. */
function table(rows: Row[]): string {
  const rest = rows.slice(TABLE_ROWS);
  return `${TABLE_HEAD}\n${rows.slice(0, TABLE_ROWS).map(row).join('\n')}${rest.length
    ? `\n\n<details><summary>…and ${plural(rest.length, 'more test')}</summary>\n\n${TABLE_HEAD}\n${
      rest.map(row).join('\n')}\n\n</details>`
    : ''}`;
}

function legend(rows: Row[]): string {
  return `_${(Object.keys(LEGEND) as Mark[]).filter((m) => rows.some((r) => r.mark === m))
    .map((m) => LEGEND[m]).join(' · ')}_`;
}

function countsLine(rows: Row[], minutes: unknown, cases = 0): string {
  const n = (m: Mark): number => rows.filter((r) => r.mark === m).length;
  const est = Number(minutes);
  return `**Counts:** ${plural(n('checks'), 'existing test')} found · ${n('new')} added for this run · ${
    plural(n('health'), 'health check')} · ${Number.isFinite(est) && est > 0
    ? `about ${Math.max(1, Math.round(est))} min` : 'time not estimated'}${
    cases > 0 ? ` (${plural(cases, 'test case')})` : ''}`;
}

/** `notRunnable` entries as "`spec` (why)", one string each. */
function notRunnableItems(v: unknown): string[] {
  return listOf<{ spec?: unknown; why?: unknown }>(v)
    .filter((n) => String(n.spec ?? '').trim())
    .map((n) => `${codeSpan(String(n.spec).trim())}${clause(n.why) ? ` (${clause(n.why)})` : ''}`);
}

function suggestion(p: { title?: unknown; file?: unknown; why?: unknown }): string {
  const file = String(p.file ?? '').trim();
  const why = flat(p.why);
  return `${clause(p.title)}${file ? ` (${codeSpan(file)})` : ''}.${why ? ` ${italic(`Why: ${why}`)}` : ''}`;
}

/**
 * The proposals a found list carries, each saying which way it goes. A remove
 * names the file when there is one: "REMOVE: Verify that…" alone would not say
 * which test goes.
 */
function proposalLines(s: Partial<LocalTestsScope>): string {
  return listOf<{ action?: unknown; title?: unknown; file?: unknown; why?: unknown }>(s.proposals).map((p) => {
    if (p.action === 'remove') {
      const file = String(p.file ?? '').trim();
      const why = flat(p.why);
      return `- REMOVE: ${file ? `${codeSpan(file)} — ` : ''}${clause(p.title)}.${why ? ` ${italic(`Why: ${why}`)}` : ''}`;
    }
    return `- ADD to the suite: ${suggestion(p)}`;
  }).join('\n');
}

/**
 * The scope's temporary changes, counted, with the patch attached: "a spec was
 * updated to match" is a claim, and the diff is the evidence.
 */
function temporaryChanges(s: Partial<LocalTestsScope>, patchFile: string | undefined): {
  line: string; attachments: Attachment[];
} {
  const edits = listOf<{ kind?: unknown }>(s.edits);
  const present = Boolean(patchFile && existsSync(patchFile));
  if (!edits.length && !present) return { line: '**Temporary changes:** none.', attachments: [] };
  const added = edits.filter((e) => e.kind === 'add').length;
  const kinds = [
    ...(edits.length - added ? [`${edits.length - added} updated`] : []),
    ...(added ? [`${added} new`] : []),
  ].join(', ');
  const what = edits.length ? `${plural(edits.length, 'file')} (${kinds}), never committed` : 'never committed';
  if (!present || !patchFile) {
    return { line: `**Temporary changes:** ${what}. The patch was not saved, so it is not attached.`, attachments: [] };
  }
  const content = readFileSync(patchFile);
  if (content.length > MAX_UPLOAD_BYTES) {
    return { line: `**Temporary changes:** ${what}. The patch is over 25 MB, so it is not attached.`, attachments: [] };
  }
  return {
    line: `**Temporary changes:** ${what} — the patch is attached.`,
    attachments: [{ name: basename(patchFile), content, mime: mimeFor(patchFile) }],
  };
}

/**
 * The temporary changes capture flagged, one entry per file with every reason:
 * a test made easier to pass, a reach outside the browser (`cy.exec(`,
 * `cy.task(`, `Cypress.env(`…), or a file outside `localTests.allowedPaths`.
 * Read from the scope's `capture`, which the conductor wrote after the session.
 */
function flaggedChanges(s: Partial<LocalTestsScope>): Array<{ file: string; why: string[] }> {
  const raw = (s as Record<string, unknown>).capture;
  if (!raw || typeof raw !== 'object') return [];
  const c = raw as Record<string, unknown>;
  const files = (v: unknown): string[] => (Array.isArray(v) ? v : [])
    .filter((f): f is string => typeof f === 'string').map(flat).filter(Boolean);
  const out = new Map<string, string[]>();
  const add = (file: string, why: string): void => {
    const list = out.get(file) ?? [];
    if (why && !list.includes(why)) list.push(why);
    out.set(file, list);
  };
  for (const d of listOf<{ file?: unknown; why?: unknown }>(c.weakenedDetail)) {
    const file = flat(d.file);
    if (file) add(file, clause(d.why));
  }
  for (const f of files(c.weakened)) add(f, '');
  for (const f of files(c.outsideAllowed)) add(f, `outside ${codeSpan('localTests.allowedPaths')}`);
  return [...out].map(([file, why]) => ({ file, why: why.length ? why : ['weakens a test'] }));
}

/**
 * A path in a code span — unless it holds `<!--`: a code span shows its text
 * as it is, so a file the session named after a marker would carry that marker
 * into the note. Such a name is shown as escaped prose instead.
 */
function pathText(file: string): string {
  return file.includes('<!--') ? mdText(file) : codeSpan(file);
}

/** The flagged changes as a bold warning and one line per file, or nothing when capture flagged none. */
function flaggedBlock(s: Partial<LocalTestsScope>): string[] {
  const flagged = flaggedChanges(s);
  if (!flagged.length) return [];
  return [`**Temporary changes that weaken a test, reach outside the browser, or touch files outside `
    + `${codeSpan('localTests.allowedPaths')} — read the patch before approving:**\n${
      flagged.map((f) => `- ${pathText(f.file)}: ${f.why.join('; ')}`).join('\n')}`];
}

/** Who is asked: the QA reviewers, mentioned so they are notified, or a line saying nobody is configured. */
function who(qa: string[]): string {
  return qa.length
    ? `${qa.map(at).join(' ')} — `
    : '_No QA reviewer is configured (config/reviewers.json `qa`)._ A QA reviewer can ';
}

const FIRST_REPLY = '_Only a reply from a QA reviewer counts, and the first one decides._';

function askToRun(qa: string[]): string {
  return `${who(qa)}reply \`approved\` to run them, or \`disapproved:\` with your changes, for example:\n\n`
    + '```\ndisapproved:\n- also run LV_23\n- remove LV_21\n```\n\n'
    + FIRST_REPLY;
}

function askWhenNone(qa: string[]): string {
  return `${who(qa)}reply with one of:\n`
    + `- \`disapproved: please check again\` — once a test for this change is on ${automationRefName()}, `
    + 'Oneshot checks again.\n'
    + '- `disapproved: added <test file>` — Oneshot runs that exact file, for example '
    + '`disapproved: added cypress/e2e/reports/reports_25_x.ts`.\n'
    + '- `disapproved: write a temporary test` — Oneshot writes one for this run only, and shows it to you '
    + 'before anything runs.\n'
    + `- \`approved\` — continue without local tests; the ticket is marked **${labels().done}**.\n\n`
    + FIRST_REPLY;
}

// ------------------------------------------------------------ the notes

/**
 * The list Oneshot found, put to QA. QA approves every local run, so this is
 * posted for every list, whatever is in it. A scope with nothing to run is the
 * not-found note instead: a table of no rows asks QA nothing they can answer.
 *
 * Temporary changes capture flagged — a weakened test, a reach outside the
 * browser, a file outside `localTests.allowedPaths` — get a bold line of their
 * own, with why, just before the ask: the patch runs on the desk beside the
 * real logins once QA approves, so "N files changed" alone is not enough.
 */
export function localTestsFoundNote(scope: ScopeLike, info: LocalTestsNoteInfo): LocalTestsNote {
  const s = scopeOf(scope);
  const rows = rowsOf(s);
  if (!rows.length) return localTestsNotFoundNote(scope, info);
  const cases = listOf<{ cases?: unknown }>(s.specs).reduce((n, x) => n + (Number(x.cases) || 0), 0);
  const notRunnable = notRunnableItems(s.notRunnable);
  const proposals = proposalLines(s);
  const temp = temporaryChanges(s, info.patchFile);
  // Clipped before it is escaped, so the cut can never land inside an entity.
  const raw = clip(flat(s.summary).replace(/[.\s]+$/, ''), SUMMARY_CHARS);
  const summary = raw ? `${mdText(raw)}${raw.endsWith('…') ? '' : '.'}` : '';
  const parts = [
    `**Oneshot found ${plural(rows.length, 'automation test')} for this ticket — waiting for QA approval to run them locally.**`,
    whatChanged(s, info),
    table(rows),
    legend(rows),
    countsLine(rows, s.estimatedMinutes, cases),
    ...(notRunnable.length ? [`**Can't run on a local machine (not run):** ${notRunnable.join('; ')}.`] : []),
    ...(proposals ? [`**Suggestions:**\n${proposals}`] : []),
    '**Why approval:** QA approves every local run.',
    temp.line,
    ...(summary ? [`<details><summary>How Oneshot chose these</summary>\n\n${summary}\n\n</details>`] : []),
    // Last before the ask, so it is what QA reads before replying.
    ...flaggedBlock(s),
    askToRun(info.qa),
    localTestsMarker('found'),
  ];
  return { body: parts.join('\n\n'), attachments: temp.attachments };
}

/**
 * No test reaches the change. Says what was checked, so "none" is a fact about
 * one commit of the suite rather than a guess, offers the test the scope would
 * add, and lists the four answers QA can give. Specs that reach the change but
 * cannot run on a desk are named, so "none" is never read as "nothing covers it".
 */
export function localTestsNotFoundNote(scope: ScopeLike, info: LocalTestsNoteInfo): LocalTestsNote {
  const s = scopeOf(scope);
  const adds = listOf<{ action?: unknown; title?: unknown; file?: unknown; why?: unknown }>(s.proposals)
    .filter((p) => p.action !== 'remove' && clause(p.title));
  const suggested = adds.length === 0
    ? `**Suggested test:** none — ${clause(s.reason) || 'nothing a test could observe changed'}.`
    : adds.length === 1
      ? `**Suggested test:** ${suggestion(adds[0]!)}`
      : `**Suggested tests:**\n${adds.map((p) => `- ${suggestion(p)}`).join('\n')}`;
  const notRunnable = notRunnableItems(s.notRunnable);
  const parts = [
    '**Oneshot found no automation test for this ticket.**',
    whatChanged(s, info),
    `Checked: workstream-automation ${automationRefName()} (commit ${sha7(info.automationSha)})`,
    suggested,
    ...(notRunnable.length
      ? [`**Tests that reach it but can't run on a local machine (not run):** ${notRunnable.join('; ')}.`]
      : []),
    askWhenNone(info.qa),
    localTestsMarker('not-found'),
  ];
  return { body: parts.join('\n\n'), attachments: [] };
}

/**
 * What the quick re-check found — or a `disapproved: added …` reply, once its
 * paths were looked up. With tests, it is the found-list again, put to QA for
 * approval. Without, one bold line saying so, with the same four answers. A
 * path QA named that is not on the automation ref is named back, so a typo is
 * not silently dropped.
 */
export function localTestsRecheckNote(
  result: LocalTestsRecheck,
  info: Pick<LocalTestsNoteInfo, 'qa' | 'mergeSha' | 'mrIid' | 'mrTitle' | 'mrs'>,
): LocalTestsNote {
  const ref = automationRefName();
  const checked = `workstream-automation ${ref} again (commit ${sha7(result.automationSha)})`;
  const unknown = [...new Set((result.unknown ?? []).map((u) => String(u ?? '').trim()).filter(Boolean))];
  const missing = unknown.length
    ? [`**Not on ${ref}:** ${unknown.map(codeSpan).join(', ')} — check the ${
      unknown.length === 1 ? 'path' : 'paths'} and reply again.`]
    : [];
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const f of result.found ?? []) {
    const file = String((typeof f === 'string' ? f : f?.file) ?? '').trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    rows.push({ mark: 'checks', file, what: typeof f === 'string' ? '' : flat(f.why) });
  }
  if (!rows.length) {
    return {
      body: [
        `**Checked ${checked}: still no automation test reaches this change.**`,
        ...missing,
        askWhenNone(info.qa),
        localTestsMarker('recheck'),
      ].join('\n\n'),
      attachments: [],
    };
  }
  return {
    body: [
      `**Oneshot found ${plural(rows.length, 'automation test')} for this ticket — waiting for QA approval to run them locally.**`,
      `Checked ${checked}.`,
      whatChanged({}, info),
      table(rows),
      countsLine(rows, result.estimatedMinutes),
      ...missing,
      '**Why approval:** QA approves every local run.',
      askToRun(info.qa),
      localTestsMarker('recheck'),
    ].join('\n\n'),
    attachments: [],
  };
}

/**
 * The record of QA going on with no local test. `approver` is a GitLab
 * username, or 'dry-run' for the approval a dry run assumes — there is nobody
 * to mention then.
 */
export function localTestsApprovedWithoutTestsNote(approver: string): LocalTestsNote {
  const by = approver === 'dry-run' ? 'approved automatically (dry run)' : `approved by ${at(approver)}`;
  return {
    body: `**No local automation run for this ticket:** no automation test exists for this change; ${by} `
      + `without local tests.\n\nMarked **${labels().done}**.\n\n${localTestsMarker('approved-without-tests')}`,
    attachments: [],
  };
}

/** How publish.ts heads the videos it attaches under its report: kept last, beside the uploads. */
const VIDEOS_HEAD = '**Videos of the failed specs:**';

/**
 * The results, rendered by the same code as the Loop's report
 * (`localTestsReportNote`), closed with the label the mode puts on: the ticket
 * is done whether the tests passed or failed, because the results are the
 * deliverable. When a failure does not fail on dev too, the MR's author is
 * mentioned: theirs is likely the change that broke it.
 *
 * A run with status `error` never happened, so it is a setup error and is
 * rendered as one — a note claiming the ticket done over a run that did not
 * take place would be false.
 */
export function localTestsResultsNote(
  run: Partial<LocalTestsRun> | Record<string, unknown>,
  ctx: PublishCtx,
  extra: { mrAuthor?: string } = {},
): LocalTestsNote {
  const r = run as Partial<LocalTestsRun>;
  if (r.status === 'error') return localTestsSetupErrorNote(String(r.reason ?? ''));
  const report = localTestsReportNote(run as Record<string, unknown>, ctx);
  let body = report?.body ?? '**Local automation results:** the run recorded no result.';
  const videos = body.endsWith(`\n\n${VIDEOS_HEAD}`);
  if (videos) body = body.slice(0, -(VIDEOS_HEAD.length + 2));
  const theirs = listOf<{ state?: unknown; failingOnDev?: unknown }>(r.results)
    .filter((x) => x.state === 'failed' && x.failingOnDev === false).length;
  const author = String(extra.mrAuthor ?? '').trim();
  const parts = [
    body,
    ...(theirs && author
      ? [`FYI ${at(author)}: ${plural(theirs, 'failed test')} ${theirs === 1 ? 'does' : 'do'} not fail on dev, `
        + `so this change likely caused ${theirs === 1 ? 'it' : 'them'}.`]
      : []),
    `Marked **${labels().done}**.`,
    ...(videos ? [VIDEOS_HEAD] : []),
    localTestsMarker('results'),
  ];
  return { body: parts.join('\n\n'), attachments: report?.attachments ?? [] };
}

/**
 * The run could not happen: the database copy, the worktree, the app build.
 * Not marked done — the trigger label goes back on, so the ticket is picked up
 * again — and the note says so, so nobody reads silence as a pass.
 */
export function localTestsSetupErrorNote(reason: string): LocalTestsNote {
  const l = labels();
  return {
    body: `**Oneshot could not run the local automation tests:** ${clause(reason) || 'no reason was recorded'}.\n\n`
      + `Not marked done: **${l.running}** is removed and **${l.trigger}** is back on the ticket, so Oneshot `
      + `picks it up again.\n\n${localTestsMarker('setup-error')}`,
    attachments: [],
  };
}

/**
 * The tests could not be chosen at all: the scope session kept failing, so
 * there is no list to put to QA and nothing ran. Unlike a setup error, no label
 * moved — the trigger is still on and nothing was marked — so the note says
 * that, and asks: Oneshot waits for a comment from a QA reviewer and, on any
 * one, tries again. QA are @mentioned for real, because nothing else tells
 * them a comment is all it takes.
 */
export function localTestsStuckNote(reason: string, qa: string[]): LocalTestsNote {
  const l = labels();
  const ask = qa.length
    ? `${qa.map(at).join(' ')} — any comment from you on this ticket makes Oneshot try again (for example what `
      + 'to look at, or just `please try again`). Until one of you comments, Oneshot waits and posts nothing more.'
    : '_No QA reviewer is configured (config/reviewers.json `qa`)_, and only a QA reviewer\'s comment makes '
      + 'Oneshot try again, so add one there first, then comment on this ticket.';
  return {
    // Clipped before it is escaped, so the cut can never land inside an entity.
    body: `**Oneshot could not choose the local automation tests for this ticket:** ${
      clause(clip(flat(reason), STUCK_REASON_CHARS)) || 'no reason was recorded'}.\n\n`
      + `No label was changed and nothing ran: **${l.trigger}** stays on the ticket, and it is not marked `
      + `**${l.done}**.\n\n${ask}\n\n${localTestsMarker('stuck')}`,
    attachments: [],
  };
}
