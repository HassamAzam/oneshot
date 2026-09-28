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
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { artifactDir, reviewersConfig } from './config.js';
import { readArtifact, updateJournal, type RunJournal } from './artifacts.js';
import {
  addIssueNote, addMergeRequestNote, mergeRequestUrl, uploadFile, type Upload,
} from './gitlab.js';
import { log } from './log.js';
import { mdText, tableCell } from './gitlabmd.js';

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
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// ------------------------------------------------------------------ rendering

/** One CSV field: quoted always, inner quotes doubled. Steps keep their newlines. */
function csvCell(v: unknown): string {
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
  summary?: string;
}

export function renderPlanMd(iid: number, title: string, plan: PlanArtifact): string {
  // Every cell holding model prose goes through `tableCell`; `layer` and
  // `status` are schema enums and `n` is a number, so they cannot break a row.
  // `files` are paths joined with `<br>` — that is a rendering choice for an
  // array, not an escape, which is why the path itself still needs one.
  const steps = (plan.steps ?? [])
    .map((s) => `| ${s.n} | ${s.layer} | ${tableCell(s.what)} | ${
      (s.files ?? []).map(tableCell).join('<br>') || '—'} |`)
    .join('\n');
  const questions = (plan.openQuestions ?? []).map((q) => `- ${q}`).join('\n');
  const outOfScope = (plan.outOfScope ?? []).map((o) => `- ${o}`).join('\n');
  const answered = (plan.feedbackResponse ?? [])
    .map((f) => `| ${tableCell(f.point)} | ${tableCell(f.response)} | ${
      tableCell(f.where) || '—'} | ${tableCell(f.note)} |`)
    .join('\n');
  const coverage = (plan.acceptanceCoverage ?? [])
    .map((c) => `| ${tableCell(c.criterion)} | ${c.status} | ${
      tableCell(c.coveredBy) || '—'} | ${tableCell(c.note)} |`)
    .join('\n');
  return `# Implementation plan — #${iid} ${title}

${answered ? `## Reviewer feedback, point by point\n| Point | Response | Where | Note |\n|---|---|---|---|\n${answered}\n\n` : ''}## Approach
${plan.approach ?? '(not recorded)'}
${questions ? `\n## Open questions\n${questions}\n` : ''}
## Steps
| # | Layer | Change | Files |
|---|---|---|---|
${steps || '| — | — | (none recorded) | — |'}
${coverage ? `\n## Acceptance coverage\n| Criterion | Status | Covered by | Note |\n|---|---|---|---|\n${coverage}\n` : ''}
## Reuse before writing
${(plan.reuse ?? []).map((r) => `- ${r}`).join('\n') || '- (none identified)'}

## Risks
${(plan.risks ?? []).map((r) => `- ${r}`).join('\n') || '- (none identified)'}
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

const SPECS: Spec[] = [
  {
    key: 'plan',
    artifact: 'plan.json',
    target: 'ticket',
    build: (data, ctx) => ({
      body: `**Plan** — how Oneshot intends to implement this.\n\n> ${
        mdText((data.approach as string ?? '').slice(0, 400))}\n\n` +
        `${(data.steps as unknown[] ?? []).length} step(s)${data.migrations ? ' · includes a migration' : ''}. ` +
        'Full plan attached; implementation follows it unless a step proves wrong.',
      attachments: [{
        name: `plan-${ctx.iid}.md`,
        content: renderPlanMd(ctx.iid, ctx.journal.title, data as PlanArtifact),
        mime: 'text/markdown',
      }],
    }),
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
      return {
        body: `**Local verification** — ${tally(results)}.\n\n${resultTable(results)}\n\n` +
          (regressions.length
            ? `**Regressions**\n${regressions.map((r) => `- ${r}`).join('\n')}\n\n`
            : '') +
          `_Run ${ctx.runId} · executed in a real browser against the branch._`,
        attachments: screenshotsFrom(ctx.iid, results, 10),
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

async function post(spec: Spec, pub: Publication, ctx: PublishCtx): Promise<boolean> {
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
    return false;
  }
  log.ok(`published ${spec.key} → ${spec.target}`, { attachments: links.length });
  return true;
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
      if (await post(spec, pub, ctx)) done.add(spec.key);
    }

    const published = [...done];
    if (published.length !== (ctx.journal.published ?? []).length) {
      const updated = updateJournal(ctx.iid, { published });
      if (updated) ctx.journal.published = published;
    }
  } catch (err) {
    log.warn('publish pass failed', { error: (err as Error).message.slice(0, 160) });
  }
}
