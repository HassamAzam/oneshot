/**
 * What a ticket's Google Drive folder holds, decided without touching Drive.
 *
 * The folder is the browsable record of one ticket — the Confluence space
 * beside the Jira issue. GitLab notes are a timeline; this is the shelf. Every
 * function here is pure over the run's artifacts so the mapping can be tested
 * without a credential, and `drivesync.ts` only has to resolve, hash and upload
 * what this file says exists.
 *
 * Names carry a two-digit prefix so the folder reads top to bottom in the order
 * the run produced them; Drive sorts by name by default and the prefix is the
 * only ordering a reader gets for free. Each entry also carries a stable `key`,
 * which is what the file is found by (as a Drive appProperty) on a later pass —
 * never the name, so a rename in the UI or a changed title never duplicates.
 */
import type { PhaseRecord } from './artifacts.js';

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

/** Subfolder the individual screenshots go into, so the top level stays a readable index. */
export const SHOTS_FOLDER = 'Screenshots';

/**
 * Where an entry's bytes come from. `text` is already rendered; `file` is read
 * (and hashed) from disk; `pdf` is assembled from screenshots only when its
 * inputs changed, because launching a browser on every pass is not free.
 */
export type EntrySource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'pdf'; meta: DemoMeta; shots: Shot[] };

export interface DriveEntry {
  /** Stable identity across passes and runs — stored as the file's appProperty. */
  key: string;
  name: string;
  /** Media type of the bytes uploaded. */
  mime: string;
  /** Set to convert on upload into a native Google Doc or Sheet. */
  convertTo?: string;
  /** Put the file in the screenshots subfolder rather than the ticket folder. */
  inShots?: boolean;
  source: EntrySource;
}

export interface DemoMeta { iid: number; title: string; issueUrl: string; summary?: string }

export interface Shot {
  file: string;
  path: string;
  caption: string;
  caseId?: string;
}

/** Everything the mapping reads — the journal's facts plus each phase's artifact, null when absent. */
export interface PackInput {
  iid: number;
  title: string;
  issueUrl: string;
  status?: string;
  stoppedPhase?: string;
  blockedWhy?: string;
  branch?: string;
  mrUrl?: string;
  mrIid?: number;
  mergedSha?: string;
  phases: PhaseRecord[];
  research: Record<string, unknown> | null;
  plan: string | null;
  testcasesCsv: string | null;
  verify: Record<string, unknown> | null;
  findings: Record<string, unknown> | null;
  shots: Shot[];
  evidenceSummary?: string;
  demoVideo: string | null;
}

/**
 * `<iid> — <title>`. Control characters and runs of whitespace are flattened
 * because a title is model-free but human-typed, and a newline in a Drive name
 * renders as nothing useful. Capped so the column stays readable; the full
 * title is in the README.
 */
export function ticketFolderName(iid: number, title: string): string {
  const clean = String(title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const capped = clean.length > 110 ? `${clean.slice(0, 109).trimEnd()}…` : clean;
  return capped ? `${iid} — ${capped}` : String(iid);
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
/** One table cell: single line, pipe-safe. */
const cell = (v: unknown): string => str(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|') || '—';

/**
 * How prose and table cells are written for one destination. Drive's markdown
 * import takes text as it is; a GitLab note goes through its HTML sanitiser,
 * which eats anything shaped like a tag (`<title> is static`), so the publisher
 * passes gitlabmd's escapers and asks for the long sections folded.
 */
export interface MdFormat {
  text: (s: string) => string;
  cell: (v: unknown) => string;
  /** Wrap the long, reference-only sections in <details> so the note reads at a glance. */
  fold: boolean;
}

const PLAIN: MdFormat = { text: (s) => s, cell, fold: false };

/**
 * The research write-up. It is the conductor's own handoff to the planner and
 * where the "why is it like this" lives, so it is the document a newcomer to
 * the ticket wants first — on the issue and in the Drive folder alike.
 */
export function renderResearchMd(
  iid: number, title: string, issueUrl: string, r: Record<string, unknown>, fmt: MdFormat = PLAIN,
): string {
  const t = (v: unknown): string => fmt.text(str(v));
  const section = (heading: string, body: string[]): string[] => (fmt.fold
    ? [`<details><summary>${heading}</summary>`, '', ...body, '', '</details>', '']
    : [`## ${heading}`, ...body, '']);
  const out: string[] = [`# Research — ${iid} ${fmt.text(title)}`, ''];
  if (!fmt.fold) out.push(`Ticket: ${issueUrl}`, '');
  if (str(r.summary)) out.push('## Summary', t(r.summary), '');
  if (str(r.understanding)) out.push('## What the ticket is asking', t(r.understanding), '');
  if (str(r.module)) out.push('## Module', t(r.module), '');
  const ac = list(r.acceptanceCriteria).map(str).filter(Boolean);
  if (ac.length) out.push('## Acceptance criteria', ...ac.map((a) => `- ${fmt.text(a)}`), '');
  const blast = list(r.blastRadius).map(str).filter(Boolean);
  if (blast.length) out.push('## Blast radius', ...blast.map((b) => `- ${fmt.text(b)}`), '');
  const unknowns = list(r.unknowns).map(str).filter(Boolean);
  if (unknowns.length) out.push('## Unknowns', ...unknowns.map((u) => `- ${fmt.text(u)}`), '');
  const repro = r.reproduction as Record<string, unknown> | undefined;
  if (repro && str(repro.verdict) && str(repro.verdict) !== 'not-applicable') {
    out.push('## Reproduction', `Verdict: **${t(repro.verdict)}**`);
    const steps = list(repro.steps).map(str).filter(Boolean);
    if (steps.length) out.push('', ...steps.map((x, i) => `${i + 1}. ${fmt.text(x)}`));
    if (str(repro.expected)) out.push('', `Expected: ${t(repro.expected)}`);
    if (str(repro.observed)) out.push('', `Observed: ${t(repro.observed)}`);
    if (str(repro.reason)) out.push('', `Note: ${t(repro.reason)}`);
    out.push('');
  }
  const path = list(r.codePath) as Array<Record<string, unknown>>;
  if (path.length) {
    out.push(...section(`Code path (${path.length} step(s))`, ['| File | Line | Role |', '|---|---|---|',
      ...path.map((p) => `| ${fmt.cell(p.file)} | ${fmt.cell(p.line)} | ${fmt.cell(p.role)} |`)]));
  }
  const ui = r.uiPath as Record<string, unknown> | undefined;
  if (ui && typeof ui === 'object') {
    const rows = Object.entries(ui)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const)
      .filter(([, v]) => str(v))
      .map(([k, v]) => `- **${k}**: ${fmt.text(str(v))}`);
    if (rows.length) out.push(...section('UI path', rows));
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The review verdict and every finding, worst first as the reviewer graded them. */
export function renderFindingsMd(iid: number, title: string, f: Record<string, unknown>): string {
  const out: string[] = [`# Review findings — ${iid} ${title}`, ''];
  if (str(f.verdict)) out.push(`Verdict: **${str(f.verdict)}**`, '');
  if (str(f.summary)) out.push(str(f.summary), '');
  const items = list(f.findings) as Array<Record<string, unknown>>;
  if (!items.length) out.push('No findings recorded.');
  for (const it of items) {
    const where = str(it.file) ? ` — ${str(it.file)}${str(it.line) ? `:${str(it.line)}` : ''}` : '';
    out.push(`## ${str(it.id) || 'Finding'} (${str(it.severity) || 'unrated'})${where}`, '');
    if (str(it.what)) out.push(`**What:** ${str(it.what)}`, '');
    if (str(it.why)) out.push(`**Why:** ${str(it.why)}`, '');
    if (str(it.fix)) out.push(`**Fix:** ${str(it.fix)}`, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The verify phase's per-case results — what was run against the real app, and what came back. */
export function renderVerifyMd(iid: number, title: string, v: Record<string, unknown>): string {
  const out: string[] = [`# Verification — ${iid} ${title}`, ''];
  if (str(v.summary)) out.push(str(v.summary), '');
  const results = list(v.results) as Array<Record<string, unknown>>;
  if (results.length) {
    out.push('| Case | Result | Evidence |', '|---|---|---|',
      ...results.map((r) => `| ${cell(r.id)} | ${cell(r.result)} | ${cell(str(r.evidence).slice(0, 400))} |`), '');
  }
  const regressions = list(v.regressions).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  if (regressions.length) out.push('## Regressions', ...regressions.map((r) => `- ${r}`), '');
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The folder's front page. It is rewritten on every pass that changes what it
 * says, so it deliberately holds no "synced at" time — that would make every
 * pass an update and bury real revisions in the Doc's history.
 */
export function renderReadmeMd(input: PackInput, contents: string[]): string {
  const out: string[] = [`# ${input.iid} — ${input.title}`, '', `Ticket: ${input.issueUrl}`];
  if (input.mrUrl) out.push('', `Merge request: ${input.mrUrl}`);
  if (input.branch) out.push('', `Branch: \`${input.branch}\``);
  const state = [input.status, input.stoppedPhase ? `at ${input.stoppedPhase}` : '']
    .filter(Boolean).join(' ');
  if (state) out.push('', `Run status: **${state}**${input.mergedSha ? ` (merged ${input.mergedSha.slice(0, 10)})` : ''}`);
  if (input.blockedWhy) out.push('', `Stopped because: ${input.blockedWhy}`);
  if (contents.length) out.push('', '## In this folder', ...contents.map((c) => `- ${c}`));
  const phases = input.phases.filter((p) => p.status !== 'skipped');
  if (phases.length) {
    out.push('', '## Phases', '| Phase | Lap | Outcome | Finished |', '|---|---|---|---|',
      ...phases.map((p) => `| ${p.phase} | ${p.lap} | ${p.status} | ${
        p.endedAt ? new Date(p.endedAt).toISOString().replace('T', ' ').slice(0, 16) : '—'} |`));
  }
  out.push('', '_Maintained by Oneshot. Edits made here are overwritten on the next run pass._');
  return `${out.join('\n')}\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The screenshot demo as one printable page: a cover, then one screenshot per
 * page with its caption under it, in the order ui-evidence chose — that order
 * is the walkthrough. Images are referenced by `src` the caller supplies (a
 * data: URI in practice), so this stays pure and testable.
 */
export function demoPdfHtml(
  meta: DemoMeta,
  shots: Array<{ src: string; caption: string; file: string; caseId?: string }>,
): string {
  const pages = shots.map((s, i) => `
<section class="page">
  <div class="n">${i + 1} / ${shots.length} · ${escapeHtml(s.file)}${s.caseId ? ` · ${escapeHtml(s.caseId)}` : ''}</div>
  <img src="${escapeHtml(s.src)}" alt="${escapeHtml(s.file)}">
  <p class="cap">${escapeHtml(s.caption)}</p>
</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(`${meta.iid} demo`)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11pt -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; }
  .page { page-break-after: always; break-after: page; display: flex; flex-direction: column; height: 184mm; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .cover { justify-content: center; }
  .cover h1 { font-size: 22pt; margin: 0 0 6mm; }
  .cover .url { color: #555; margin-bottom: 8mm; word-break: break-all; }
  .n { font-size: 9pt; color: #777; margin-bottom: 3mm; }
  img { max-width: 100%; max-height: 145mm; object-fit: contain; align-self: center; border: 1px solid #ddd; }
  .cap { margin: 4mm 0 0; line-height: 1.4; }
</style></head><body>
<section class="page cover">
  <h1>${escapeHtml(`${meta.iid} — ${meta.title}`)}</h1>
  <div class="url">${escapeHtml(meta.issueUrl)}</div>
  ${meta.summary ? `<p>${escapeHtml(meta.summary)}</p>` : ''}
  <p class="n">${shots.length} screenshot(s), in walkthrough order.</p>
</section>${pages}
</body></html>`;
}

/**
 * Every file the ticket folder should hold right now, in folder order.
 *
 * An artifact that does not exist yet simply has no entry: the folder fills in
 * as the run moves, and the README's contents list says what is there so far.
 */
export function packEntries(input: PackInput): DriveEntry[] {
  const { iid, title, issueUrl } = input;
  const entries: DriveEntry[] = [];
  const md = (key: string, name: string, text: string): DriveEntry =>
    ({ key, name, mime: 'text/markdown', convertTo: GOOGLE_DOC, source: { kind: 'text', text } });

  if (input.research) entries.push(md('research', '01 Research', renderResearchMd(iid, title, issueUrl, input.research)));
  if (input.plan) entries.push(md('plan', '02 Plan', input.plan));
  if (input.testcasesCsv) {
    entries.push({
      key: 'testcases', name: '03 Test cases', mime: 'text/csv', convertTo: GOOGLE_SHEET,
      source: { kind: 'text', text: input.testcasesCsv },
    });
  }
  if (input.verify) entries.push(md('verify', '04 Verification', renderVerifyMd(iid, title, input.verify)));
  if (input.findings) entries.push(md('review', '05 Review findings', renderFindingsMd(iid, title, input.findings)));
  if (input.shots.length) {
    entries.push({
      key: 'demo-pdf', name: '06 Demo — screenshots.pdf', mime: 'application/pdf',
      // drivesync renders `demoPdfHtml` with the image bytes inlined, and
      // hashes meta + shots + those bytes first, so the browser only launches
      // when a screenshot or caption actually changed.
      source: { kind: 'pdf', meta: { iid, title, issueUrl, summary: input.evidenceSummary }, shots: input.shots },
    });
  }
  if (input.demoVideo) {
    const ext = input.demoVideo.slice(input.demoVideo.lastIndexOf('.'));
    entries.push({
      key: 'demo-video', name: `07 Demo video${ext}`, mime: ext === '.mp4' ? 'video/mp4' : 'video/webm',
      source: { kind: 'file', path: input.demoVideo },
    });
  }
  for (const s of input.shots) {
    entries.push({
      key: `shot:${s.file}`, name: s.file, mime: s.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      inShots: true, source: { kind: 'file', path: s.path },
    });
  }

  const contents = entries.filter((e) => !e.inShots).map((e) => e.name);
  if (input.shots.length) contents.push(`${SHOTS_FOLDER}/ (${input.shots.length} image(s))`);
  if (input.mrUrl) contents.push(`Merge request: ${input.mrUrl}`);
  entries.unshift(md('readme', '00 README', renderReadmeMd(input, contents)));
  return entries;
}

// ------------------------------------------------------------- ticket index

/**
 * The one spreadsheet at the root that lists every ticket — the board view of
 * the shelf. One row per ticket, found again by its issue URL, so a re-run, a
 * renamed title or a second desk rewrites the row instead of adding one.
 */
export const INDEX_NAME = 'Oneshot ticket index';
export const INDEX_HEADER = [
  'Ticket', 'Title', 'Status', 'Current phase', 'Last updated',
  'Plan', 'Research', 'Test cases', 'Demo PDF', 'Demo video', 'MR', 'Drive folder',
];

export interface IndexInput {
  iid: number;
  title: string;
  issueUrl: string;
  status?: string;
  mergedSha?: string;
  stoppedPhase?: string;
  phases: PhaseRecord[];
  createdAt?: number;
  stoppedAt?: number;
  mrUrl?: string;
  folderUrl?: string;
  /** Drive file id per entry key — `journal.drive.files`. */
  files: Record<string, { id: string }>;
}

/**
 * The status a reader of the index wants, from the journal's. `parked` is a
 * run waiting on a person (a gate, a human merge); `done` without a merge sha
 * is a run that finished short of merging (a Review ticket handed over).
 */
export function indexStatus(status: string | undefined, mergedSha?: string): string {
  if (status === 'done') return mergedSha ? 'merged' : 'done';
  if (status === 'parked') return 'on a gate';
  return status || 'running';
}

/** A Sheets formula string literal. */
const lit = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const link = (url: string, label: string): string => `=HYPERLINK(${lit(url)},${lit(label)})`;
/**
 * A plain cell, forced to text. The apostrophe stops Sheets reading a title
 * that begins with `=`, `+`, `-` or `@` as a formula (the CSV-injection shape)
 * and stops it turning "2026-11-10 09:00 UTC" into a date serial — either of
 * which would also make the row never compare equal to what was written.
 */
const text = (s: string): string => (s ? `'${s}` : '');

function stamp(ms: number | undefined): string {
  return ms ? `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
}

/**
 * One ticket's row. "Last updated" is the run's own last activity, not the
 * time of the pass — so a pass with nothing new produces the identical row and
 * costs no write.
 */
export function indexRow(input: IndexInput): string[] {
  const f = input.files;
  const doc = (k: string): string => (f[k] ? `https://docs.google.com/document/d/${f[k]!.id}/edit` : '');
  const sheet = (k: string): string => (f[k] ? `https://docs.google.com/spreadsheets/d/${f[k]!.id}/edit` : '');
  const file = (k: string): string => (f[k] ? `https://drive.google.com/file/d/${f[k]!.id}/view` : '');
  const cellLink = (url: string, label: string): string => (url ? link(url, label) : '');
  const last = input.phases[input.phases.length - 1];
  const latest = Math.max(input.createdAt ?? 0, input.stoppedAt ?? 0, ...input.phases.map((p) => p.endedAt || p.startedAt || 0));
  return [
    link(input.issueUrl, String(input.iid)),
    text(input.title),
    text(indexStatus(input.status, input.mergedSha)),
    text(input.stoppedPhase ?? last?.phase ?? ''),
    text(stamp(latest || undefined)),
    cellLink(doc('plan'), 'Plan'),
    cellLink(doc('research'), 'Research'),
    cellLink(sheet('testcases'), 'Test cases'),
    cellLink(file('demo-pdf'), 'Demo PDF'),
    cellLink(file('demo-video'), 'Demo video'),
    input.mrUrl ? link(input.mrUrl, input.mrUrl) : '',
    cellLink(input.folderUrl ?? '', 'Folder'),
  ];
}

/**
 * The 1-based sheet row holding `issueUrl`, from column A read with formulas
 * (row 1 is the header). Matched on the issue URL inside the HYPERLINK, never
 * on the label alone: two projects can share an iid, and the URL is the
 * ticket's real identity. Null when the ticket has no row yet.
 */
export function findIndexRow(columnA: string[], issueUrl: string): number | null {
  const want = issueUrl.replace(/\/+$/, '');
  for (let i = 1; i < columnA.length; i++) {
    const m = /^=HYPERLINK\("((?:[^"]|"")*)"/i.exec(String(columnA[i] ?? '').trim());
    if (m && m[1]!.replace(/""/g, '"').replace(/\/+$/, '') === want) return i + 1;
  }
  return null;
}

/**
 * Whether the row as read back (formulas, trailing blanks trimmed by Sheets)
 * already says what `row` would write. The text apostrophe is not part of what
 * Sheets returns, so it is dropped before comparing.
 */
export function sameRow(existing: string[] | undefined, row: string[]): boolean {
  const norm = (r: string[]): string[] => {
    const out = r.map((c) => String(c ?? '').replace(/^'/, ''));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };
  return JSON.stringify(norm(existing ?? [])) === JSON.stringify(norm(row));
}
