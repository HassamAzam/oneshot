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
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DRY_RUN, artifactDir, projectConfig } from '../lib/config.js';
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

/** The ticket comment. Written for QA and the reporter, not for the pipeline. */
export function notABugComment(
  repro: Reproduction,
  opts: { runId: string; label?: string; entryLabel: string; screenshots: Upload[] },
): string {
  const steps = repro.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const shots = opts.screenshots.map((u) => u.markdown).join('\n');
  const extraEvidence = repro.evidence.filter((e) => !/\.png$/i.test(e));
  return [
    `**Oneshot could not reproduce this bug** — the run has stopped before planning a fix` +
      `${opts.label ? ` and labelled the ticket **${opts.label}**` : ''}.`,
    '',
    `**Why:** ${repro.reason || '(no reason recorded)'}`,
    '',
    '**What was run**',
    `- Code: \`${repro.testedCommit}\` (unfixed base branch)`,
    `- Account: ${repro.account || '(not recorded)'}`,
    '',
    steps,
    '',
    `**Expected (from the ticket):** ${repro.expected || '(not recorded)'}`,
    '',
    `**Observed:** ${repro.observed}`,
    ...(extraEvidence.length ? ['', '**Measurements**', ...extraEvidence.map((e) => `- ${e}`)] : []),
    ...(shots ? ['', shots] : []),
    '',
    '---',
    `If this is still a bug — different data, role, browser, device or environment — add those ` +
      `details here, remove ${opts.label ? `**${opts.label}**` : 'the stop'} and add **${opts.entryLabel}** back. ` +
      `Oneshot will resume run \`${opts.runId}\` from planning without reproducing again.`,
  ].join('\n');
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

    const screenshots = await uploadScreenshots(iid, repro.evidence);
    const noted = await addIssueNote(iid, notABugComment(repro, {
      runId, label, entryLabel: cfg.labels.entry, screenshots,
    }));
    if (!noted.ok) log.warn(`not-a-bug: ticket comment failed on #${iid}`, { error: noted.error ?? noted.kind });
  }

  await thread(null, notABugSlackText(iid, title, repro, label));
  log.warn(`■ #${iid} — ${reason}`);
  return reason;
}
