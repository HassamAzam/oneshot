/**
 * Publish a run's artifacts to GitLab AS THEY LAND, not at the end.
 *
 * The `document` phase already writes the durable record, but it runs second
 * from last — so for most of a run's life the ticket says nothing and whoever
 * is watching has to read a Slack card to learn anything. That is backwards for
 * the two artifacts people actually want early: the PLAN, which is the last
 * cheap moment to say "not like that", and the TEST CASES, which QA wants in
 * their own format long before the code is deployed.
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
import { artifactDir } from './config.js';
import { readArtifact, updateJournal, type RunJournal } from './artifacts.js';
import { addIssueNote, addMergeRequestNote, uploadFile, type Upload } from './gitlab.js';
import { log } from './log.js';

/** GitLab rejects very large attachments; skip them with a note rather than failing. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function mimeFor(name: string): string {
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
  summary?: string;
}

function renderPlanMd(iid: number, title: string, plan: PlanArtifact): string {
  const steps = (plan.steps ?? [])
    .map((s) => `| ${s.n} | ${s.layer} | ${s.what} | ${(s.files ?? []).join('<br>') || '—'} |`)
    .join('\n');
  return `# Implementation plan — #${iid} ${title}

## Approach
${plan.approach ?? '(not recorded)'}

## Steps
| # | Layer | Change | Files |
|---|---|---|---|
${steps || '| — | — | (none recorded) | — |'}

## Reuse before writing
${(plan.reuse ?? []).map((r) => `- ${r}`).join('\n') || '- (none identified)'}

## Risks
${(plan.risks ?? []).map((r) => `- ${r}`).join('\n') || '- (none identified)'}

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
        (data.approach as string ?? '').slice(0, 400)}\n\n` +
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
          'This one list is executed locally, for screenshots, and again against the deployed build.',
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
      if (!shots.length) return null;
      const dir = artifactDir(ctx.iid);
      const attachments: Attachment[] = [];
      for (const s of shots.slice(0, 12)) {
        const p = join(dir, s.file);
        if (!existsSync(p)) continue;
        const content = readFileSync(p);
        if (content.length > MAX_UPLOAD_BYTES) continue;
        attachments.push({ name: s.file, content, mime: mimeFor(s.file) });
      }
      if (!attachments.length) return null;
      return {
        body: `**UI evidence** — ${attachments.length} screenshot(s).\n\n` +
          shots.slice(0, 12).map((s) => `- \`${s.file}\`${s.caseId ? ` (${s.caseId})` : ''} — ${s.caption}`).join('\n'),
        attachments,
      };
    },
  },
  {
    key: 'qa',
    artifact: 'qa.json',
    target: 'mr',
    build: (data, ctx) => {
      const results = (data.results as CaseResult[]) ?? [];
      const verdict = String(data.verdict ?? 'unknown');
      return {
        body: `**QA on the demo server** — verdict **${verdict}** (${tally(results)}).\n\n` +
          `Deployed SHA \`${String(data.deployedSha ?? '?').slice(0, 12)}\`\n\n${resultTable(results)}\n\n` +
          `_Run ${ctx.runId} · the same case list, executed against the deployed build._`,
        attachments: screenshotsFrom(ctx.iid, results, 10),
      };
    },
  },
  {
    key: 'demo',
    artifact: 'demo.json',
    target: 'mr',
    build: (data, ctx) => {
      const files = (data.files as string[]) ?? [];
      const dir = artifactDir(ctx.iid);
      const attachments: Attachment[] = [];
      const skipped: string[] = [];
      for (const f of files) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        const content = readFileSync(p);
        if (content.length > MAX_UPLOAD_BYTES) { skipped.push(f); continue; }
        attachments.push({ name: f, content, mime: mimeFor(f) });
      }
      if (!attachments.length && !skipped.length) return null;
      return {
        body: `**Demo** — recorded walkthrough of the change on the demo server.` +
          (skipped.length ? `\n\nToo large to attach: ${skipped.join(', ')} (left in the run's artifacts).` : ''),
        attachments,
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

  const body = `${pub.body}${links.length ? `\n\n${links.join('\n\n')}` : ''}`;
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
 * merged and deployed correctly must not be marked blocked because GitLab
 * refused an attachment.
 */
export async function publishPending(ctx: PublishCtx): Promise<void> {
  try {
    const done = new Set(ctx.journal.published ?? []);
    for (const spec of SPECS) {
      if (done.has(spec.key)) continue;
      if (spec.target === 'mr' && !ctx.journal.mrIid) continue;

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
