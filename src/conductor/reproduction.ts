/**
 * Acting on research's bug-reproduction verdict.
 *
 * Research reproduces a reported bug on the unfixed base branch (skill:
 * bug-reproduction) and records a verdict. This file decides whether that
 * verdict stops the run, and when it does, says so in the three places a
 * person will look: the ticket's labels, a comment on the ticket, and the
 * Slack channel.
 *
 * The decision is deliberately lopsided. Stopping a real bug as "Not a Bug"
 * is the expensive mistake — it silently drops a defect someone reported —
 * so only a complete 'not-reproduced' (a bug, steps actually executed, the
 * correct behaviour observed on a recorded commit) stops anything. A
 * not-reproduced verdict that is missing any of that is treated as
 * inconclusive, and the run carries on as it always did.
 *
 * A 'reproduced' verdict stops nothing, but it is posted on the ticket too,
 * with its screenshots, so QA sees the bug was confirmed before the fix is
 * planned. Both comments are rendered from the skill's templates/ folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DRY_RUN, ROOT, artifactDir, projectConfig } from '../lib/config.js';
import { addIssueNote, issueUrl, swapLabel, uploadFile, type Upload } from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import { thread } from '../lib/slack.js';

export interface Reproduction {
  kind: 'bug' | 'feature';
  verdict: 'reproduced' | 'not-reproduced' | 'inconclusive' | 'not-applicable';
  testedCommit: string;
  account: string;
  steps: string[];
  expected: string;
  observed: string;
  evidence: string[];
  reason: string;
}

export type ReproductionDecision =
  | { stop: true; repro: Reproduction }
  | { stop: false; note?: string };

const MAX_SCREENSHOTS = 3;

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map(strOf).filter(Boolean) : [];
}

/** research.json's `reproduction`, normalised, or null when research recorded none. */
export function reproductionOf(research: Record<string, unknown> | null | undefined): Reproduction | null {
  const r = research?.reproduction as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return null;
  return {
    kind: r.kind === 'feature' ? 'feature' : 'bug',
    verdict: (['reproduced', 'not-reproduced', 'inconclusive', 'not-applicable'] as const)
      .find((v) => v === r.verdict) ?? 'inconclusive',
    testedCommit: strOf(r.testedCommit),
    account: strOf(r.account),
    steps: listOf(r.steps),
    expected: strOf(r.expected),
    observed: strOf(r.observed),
    evidence: listOf(r.evidence),
    reason: strOf(r.reason),
  };
}

/** Whether research's verdict ends the run as Not a Bug. */
export function notABugDecision(research: Record<string, unknown> | null | undefined): ReproductionDecision {
  const repro = reproductionOf(research);
  if (!repro || repro.verdict !== 'not-reproduced') return { stop: false };

  const missing = [
    repro.kind !== 'bug' ? 'the ticket was classed a feature, not a bug' : '',
    repro.steps.length === 0 ? 'no executed steps were recorded' : '',
    !repro.observed ? 'nothing observed was recorded' : '',
    !repro.testedCommit ? 'no tested commit was recorded' : '',
  ].filter(Boolean);
  if (missing.length) {
    return {
      stop: false,
      note: `reproduction said not-reproduced, but ${missing.join('; ')} — treated as inconclusive, the run continues`,
    };
  }
  return { stop: true, repro };
}

/** Where the skill keeps the ticket comment, one template per verdict that posts. */
const TEMPLATES = join(ROOT, 'skills', 'bug-reproduction', 'templates');

/**
 * The ticket comment for a verdict that posts one. Written for QA and the
 * reporter, not for the pipeline.
 *
 * The wording lives in the skill folder (templates/<verdict>.md) so the skill
 * owns what the ticket is told; this only fills the placeholders. A placeholder
 * with nothing to say renders empty, and the blank lines it leaves collapse.
 */
export function reproductionComment(
  repro: Reproduction,
  opts: { screenshots: Upload[]; runId?: string; label?: string; entryLabel?: string },
): string {
  const verdict = repro.verdict === 'not-reproduced' ? 'not-reproduced' : 'reproduced';
  const measurements = repro.evidence.filter((e) => !/\.png$/i.test(e));
  const values: Record<string, string> = {
    reason: repro.reason || '(no reason recorded)',
    commit: repro.testedCommit || '(not recorded)',
    account: repro.account || '(not recorded)',
    steps: repro.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    expected: repro.expected || '(not recorded)',
    observed: repro.observed || '(not recorded)',
    measurements: measurements.length ? ['**Measurements**', ...measurements.map((e) => `- ${e}`)].join('\n') : '',
    screenshots: opts.screenshots.length
      ? opts.screenshots.map((u) => u.markdown).join('\n')
      : '_No screenshot was attached._',
    labelClause: opts.label ? ` and labelled the ticket **${opts.label}**` : '',
    labelRef: opts.label ? `**${opts.label}**` : 'the stop',
    entryLabel: opts.entryLabel ?? '',
    runId: opts.runId ?? '',
  };
  return readFileSync(join(TEMPLATES, `${verdict}.md`), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The Slack channel post. */
export function notABugSlackText(iid: number, title: string, repro: Reproduction, label?: string): string {
  return `:mag: *#${iid} ${title}* — could not reproduce on \`${repro.testedCommit.slice(0, 8)}\`` +
    `${label ? `, labelled *${label}*` : ''}. The run stopped before planning.\n` +
    `>${(repro.reason || repro.observed).slice(0, 300)}\n${issueUrl(iid)}`;
}

/** Upload up to MAX_SCREENSHOTS evidence screenshots research wrote to the run's artifacts dir. */
async function uploadScreenshots(iid: number, evidence: string[]): Promise<Upload[]> {
  const out: Upload[] = [];
  for (const name of evidence.filter((e) => /\.png$/i.test(e)).slice(0, MAX_SCREENSHOTS)) {
    const path = join(artifactDir(iid), basename(name));
    if (!existsSync(path)) continue;
    const res = await uploadFile(basename(name), readFileSync(path), 'image/png');
    if (res.ok && res.data) out.push(res.data);
    else log.warn(`not-a-bug: screenshot upload failed for ${basename(name)}`, { error: res.error ?? res.kind });
  }
  return out;
}

/** Upload the screenshots and post the verdict's ticket comment. Never throws. */
async function postComment(
  iid: number, repro: Reproduction, opts: { runId?: string; label?: string; entryLabel?: string },
): Promise<void> {
  try {
    const screenshots = await uploadScreenshots(iid, repro.evidence);
    const noted = await addIssueNote(iid, reproductionComment(repro, { ...opts, screenshots }));
    if (!noted.ok) log.warn(`${repro.verdict}: ticket comment failed on #${iid}`, { error: noted.error ?? noted.kind });
  } catch (err) {
    log.warn(`${repro.verdict}: ticket comment failed on #${iid}`, { error: (err as Error).message.slice(0, 160) });
  }
}

/**
 * Tell the ticket the bug was reproduced, with the screenshots, before the fix
 * is planned. The run carries on; nothing is labelled.
 */
export async function declareReproduced(iid: number, repro: Reproduction): Promise<void> {
  if (DRY_RUN) return;
  await postComment(iid, repro, {});
  log.info(`#${iid} — reproduced on ${repro.testedCommit.slice(0, 8)}`);
}

/**
 * Label, comment and post. Returns the reason the run stops with.
 *
 * Each step is independent and none throws: a Slack outage must not leave the
 * ticket unlabelled, and a failed label must not swallow the comment that
 * explains it.
 */
export async function declareNotABug(
  iid: number, title: string, runId: string, repro: Reproduction,
): Promise<string> {
  const cfg = projectConfig();
  const label = cfg.labels.notABug || undefined;
  const reason = `not a bug: could not reproduce on ${repro.testedCommit.slice(0, 8)} — ${repro.reason || repro.observed}`
    .slice(0, 400);

  if (!DRY_RUN) {
    const remove = [cfg.labels.entry, cfg.labels.testcaseReview].filter(Boolean);
    const labelled = await swapLabel(iid, remove, label ? [label] : []);
    if (!labelled.ok) log.warn(`not-a-bug: label update failed on #${iid}`, { error: labelled.error ?? labelled.kind });

    await postComment(iid, repro, { runId, label, entryLabel: cfg.labels.entry });
  }

  await thread(null, notABugSlackText(iid, title, repro, label));
  log.warn(`■ #${iid} — ${reason}`);
  return reason;
}
