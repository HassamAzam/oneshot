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
 * correct behaviour observed on a recorded commit, with a screenshot) stops
 * anything. A not-reproduced verdict that is missing any of that is treated
 * as inconclusive, and the run carries on as it always did.
 *
 * Even a complete verdict does not label anything on its own. It arms the
 * `notABug` gate (reviewgate.ts): the evidence goes on the ticket and a QA
 * reviewer decides. `approved` is what calls `declareNotABug`; any other reply
 * is treated as the context the reproduction missed, and `research` runs again
 * with it. A machine that could not reproduce something is not the same as a
 * person agreeing there is nothing to fix.
 *
 * A 'reproduced' verdict stops nothing, but a complete one is posted on the
 * ticket too, with its screenshots, so QA sees the bug was confirmed before
 * the fix is planned. That comment and the one posted once QA confirms Not a Bug are
 * rendered from the skill's templates/ folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DRY_RUN, ROOT, artifactDir, projectConfig } from '../lib/config.js';
import { addIssueNote, issueUrl, swapLabel, uploadFile, type Upload } from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import { approverLine, type GateAttachment } from './reviewgate.js';
import { thread } from '../lib/slack.js';

/**
 * The seven blocker values, in one place. They appear in the schema the model
 * fills, in the type, and in the normaliser below; three hand-kept copies is
 * how they drift apart.
 */
export const BLOCKERS = ['none', 'env', 'data', 'access', 'surface', 'steps', 'flake'] as const;
export type Blocker = typeof BLOCKERS[number];

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
  /** What stopped an inconclusive run; 'none' on every other verdict. */
  blocker: Blocker;
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
  // Normalised first, because the blocker is derived from it: an unrecognised
  // verdict becomes `inconclusive`, and an inconclusive verdict is the only one
  // whose blocker means anything.
  const verdict = (['reproduced', 'not-reproduced', 'inconclusive', 'not-applicable'] as const)
    .find((v) => v === r.verdict) ?? 'inconclusive';
  return {
    kind: r.kind === 'feature' ? 'feature' : 'bug',
    verdict,
    testedCommit: strOf(r.testedCommit),
    account: strOf(r.account),
    steps: listOf(r.steps),
    expected: strOf(r.expected),
    observed: strOf(r.observed),
    evidence: listOf(r.evidence),
    reason: strOf(r.reason),
    blocker: blockerOf(verdict, r.blocker),
  };
}

/**
 * A blocker only means anything on `inconclusive`, so it is derived from the
 * verdict rather than trusted alongside it. Three combinations the skill forbids
 * used to survive into the record: `reproduced` with a blocker set, and an
 * artifact written before the field existed. It takes the NORMALISED verdict, so
 * an unrecognised one — which becomes `inconclusive` — keeps the blocker that
 * came with it rather than silently losing it.
 */
function blockerOf(verdict: Reproduction['verdict'], blocker: unknown): Blocker {
  if (verdict !== 'inconclusive') return 'none';
  return BLOCKERS.find((b) => b === blocker) ?? 'none';
}

/**
 * The screenshot filename an evidence line cites, or null if it cites none.
 *
 * `evidence` is documented as bare filenames, and the model writes prose around
 * them. Every reader of this field used to test `/\.png$/i`, so all of them saw
 * zero screenshots on a run that captured four: `incompleteness` reported "no
 * screenshot was recorded" and `declareReproduced` posted NOTHING on a confirmed
 * bug, while the attachment paths ran `basename()` over the whole sentence and
 * resolved to a fragment of the prose.
 *
 * DO NOT ANCHOR THIS. The first fix swapped the end anchor for the leading token
 * and failed the same way — six ordinary shapes (backticks, an em-dash with no
 * space, a trailing full stop, parentheses, bold, quotes) matched nothing, and it
 * was NARROWER than what it replaced: `Screenshot: repro-1.png` and
 * `see repro-1.png` had matched before and stopped matching, so a run already
 * parked at the gate could resume and walk past it. Position is not the signal.
 *
 * The signal is the GLOB. A blocked run writes "No repro-*.png — the app never
 * came up, so no screenshot could be captured", naming the extension precisely to
 * say there are none; counting that reports evidence for a run that produced none,
 * which is the expensive direction. `*` is absent from the name class, so the
 * pattern cannot match inside a glob — the explicit check is the second line of
 * defence if that class is ever widened.
 *
 * Returning the NAME rather than a boolean is the point: the callers that attach
 * and upload need the filename, not the sentence it arrived in. A path resolves to
 * its basename, which all four callers already apply.
 */
const SHOT = /(?:^|[\s"'`(\[*—–/])([A-Za-z0-9][\w.-]*\.(?:png|jpe?g|webp))(?=$|[\s"'`)\].,;:*—–])/i;

export function shotName(line: string): string | null {
  const name = SHOT.exec(line)?.[1];
  return name && !name.includes('*') ? name : null;
}

/**
 * Whatever the line says ABOUT the screenshot, with the filename and the
 * punctuation joining them removed. Without this the note on a screenshot line
 * is lost twice over: `shotName` excludes the line from Measurements, and the
 * upload renders as `![file](url)` with no caption, so a measured value that used
 * to be visible-but-unattached becomes attached-but-invisible.
 */
export function shotCaption(line: string, name: string): string {
  const i = line.indexOf(name);
  if (i < 0) return line.trim();
  // Collapse the gap the filename left behind, or a mid-line name yields a caption
  // with a hole in it.
  const rest = (line.slice(0, i) + ' ' + line.slice(i + name.length)).replace(/\s+/g, ' ').trim();
  const trimmed = rest.replace(/^[\s—–:,;*`'"()[\]-]+/, '').replace(/[\s*`'"\-—–:;,]+$/, '').trim();
  // A bare label ("Screenshot", "see") is not a caption; it is the word that
  // happened to introduce the filename, and rendering it under the image is noise.
  return /^(screenshot|shot|image|see|evidence|attached)$/i.test(trimmed) ? '' : trimmed;
}

/**
 * An uploaded screenshot, plus the two things `Upload` cannot carry: the filename
 * it came from and the note that accompanied it. Both optional, so a caller with
 * nothing but an `Upload` still type-checks.
 */
export type ReproShot = Upload & { name?: string; caption?: string };

/**
 * The media type GitLab is told, derived from the name rather than assumed.
 * `shotName` accepts jpeg and webp, so a hard-coded 'image/png' would declare a
 * `.jpg` upload as a PNG.
 */
export function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** How many of the evidence lines cite a screenshot. */
export function shotsIn(evidence: string[]): number {
  return evidence.filter((e) => shotName(e) !== null).length;
}

/**
 * What a verdict must carry before it is asserted on the ticket: the ticket is a
 * bug, steps were actually executed, something was observed, on a recorded
 * commit, with a screenshot someone can look at.
 *
 * Shared by both verdicts on purpose. The cost of an unevidenced claim differs
 * between them — one stops the run, one is read by the reporter — but neither is
 * a claim this pipeline should make without the evidence behind it.
 */
export function incompleteness(repro: Reproduction): string[] {
  return [
    repro.kind !== 'bug' ? 'the ticket was classed a feature, not a bug' : '',
    repro.steps.length === 0 ? 'no executed steps were recorded' : '',
    !repro.observed ? 'nothing observed was recorded' : '',
    !repro.testedCommit ? 'no tested commit was recorded' : '',
    !repro.evidence.some((e) => shotName(e)) ? 'no screenshot was recorded' : '',
  ].filter(Boolean);
}

/** Whether research's verdict ends the run as Not a Bug. */
export function notABugDecision(research: Record<string, unknown> | null | undefined): ReproductionDecision {
  const repro = reproductionOf(research);
  if (!repro || repro.verdict !== 'not-reproduced') return { stop: false };

  const missing = incompleteness(repro);
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
 * Any other verdict posts nothing, so asking for its comment throws rather than
 * rendering the wrong headline.
 */
export function reproductionComment(
  repro: Reproduction,
  opts: { screenshots: ReproShot[]; runId?: string; label?: string; entryLabel?: string },
): string {
  if (repro.verdict !== 'reproduced' && repro.verdict !== 'not-reproduced') {
    throw new Error(`reproductionComment: ${repro.verdict} does not post a comment`);
  }
  const verdict = repro.verdict;
  // A screenshot line's note belongs with its image. When the shot was NOT
  // attached — upload failed, file missing, or past MAX_SCREENSHOTS — the note
  // would otherwise be dropped twice over, so it falls back to a measurement.
  const attached = new Set(opts.screenshots.map((s) => s.name).filter((n): n is string => !!n));
  const measurements = repro.evidence.flatMap((e) => {
    const name = shotName(e);
    if (!name) return [e];
    if (attached.has(name)) return [];
    const caption = shotCaption(e, name);
    return caption ? [`${name} (not attached): ${caption}`] : [];
  });
  const values: Record<string, string> = {
    reason: repro.reason || '(no reason recorded)',
    commit: repro.testedCommit || '(not recorded)',
    account: repro.account || '(not recorded)',
    steps: repro.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    expected: repro.expected || '(not recorded)',
    observed: repro.observed || '(not recorded)',
    measurements: measurements.length ? ['**Measurements**', ...measurements.map((e) => `- ${e}`)].join('\n') : '',
    screenshots: opts.screenshots.length
      ? opts.screenshots.map((u) => (u.caption ? `${u.markdown}\n${u.caption}` : u.markdown)).join('\n\n')
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

/** Steps, expected, observed and measurements — the evidence half of the gate's request. */
function evidenceBody(repro: Reproduction): string[] {
  const steps = repro.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  // Same reasoning as the ticket comment: the gate's attachments render without
  // captions, so a note written on a screenshot line has to survive here too.
  const extraEvidence = repro.evidence.flatMap((e) => {
    const name = shotName(e);
    if (!name) return [e];
    const caption = shotCaption(e, name);
    return caption ? [`${name}: ${caption}`] : [];
  });
  return [
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
  ];
}

/**
 * The `notABug` gate's request, posted when research could not reproduce the
 * bug and before anything is labelled. The screenshots are attached below it
 * by the gate. Written for QA: what was tried, and the two ways to answer.
 */
export function notABugApprovalRequestBody(repro: Reproduction, label?: string): string {
  return [
    '**Oneshot pauses here** — research could not reproduce this bug on the unfixed base branch. ' +
      `Nothing has been labelled yet: a person confirms before this ticket is closed as ${label ? `**${label}**` : 'not a bug'}.`,
    '',
    `**Why:** ${repro.reason || '(no reason recorded)'}`,
    '',
    ...evidenceBody(repro),
    '',
    '---',
    '',
    approverLine('notABug'),
    '',
    `Comment the single word **\`approved\`** to confirm${label ? ` — the ticket is labelled **${label}**` : ''} and the run stops.`,
    '',
    'Any other comment from those accounts is treated as FEEDBACK and research reproduces the bug again ' +
      'with it — so say what the attempt above missed: the data, role, steps, browser or environment ' +
      'the bug needs. There is no limit on how many rounds this takes. Comments from anyone else are ' +
      'ignored by this gate.',
  ].join('\n');
}

/** The Slack channel post. */
export function notABugSlackText(iid: number, title: string, repro: Reproduction, label?: string): string {
  return `:mag: *#${iid} ${title}* — could not reproduce on \`${repro.testedCommit.slice(0, 8)}\`` +
    `${label ? `, labelled *${label}*` : ''}. The run stopped before planning.\n` +
    `>${(repro.reason || repro.observed).slice(0, 300)}\n${issueUrl(iid)}`;
}

/**
 * Up to MAX_SCREENSHOTS of research's screenshots, as gate attachments. The
 * gate re-uploads them each round, which is right: a round exists because
 * research ran again and took new ones.
 */
export function reproAttachments(iid: number, evidence: string[]): GateAttachment[] {
  return evidence.map(shotName).filter((n): n is string => n !== null).slice(0, MAX_SCREENSHOTS)
    .map((name) => join(artifactDir(iid), basename(name)))
    .filter((path) => existsSync(path))
    .map((path) => ({ name: basename(path), content: readFileSync(path), mime: mimeOf(path) }));
}

/** Upload up to MAX_SCREENSHOTS evidence screenshots research wrote to the run's artifacts dir. */
async function uploadScreenshots(iid: number, evidence: string[]): Promise<ReproShot[]> {
  const out: ReproShot[] = [];
  const lines = evidence.map((e) => ({ line: e, name: shotName(e) }))
    .filter((x): x is { line: string; name: string } => x.name !== null);
  for (const { line, name } of lines.slice(0, MAX_SCREENSHOTS)) {
    const path = join(artifactDir(iid), basename(name));
    if (!existsSync(path)) continue;
    const res = await uploadFile(basename(name), readFileSync(path), mimeOf(name));
    if (res.ok && res.data) out.push({ ...res.data, name: basename(name), caption: shotCaption(line, name) });
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
 * is planned. The run carries on; nothing is labelled. An incomplete verdict
 * posts nothing: it would put an unevidenced claim in front of the reporter.
 */
export async function declareReproduced(iid: number, repro: Reproduction): Promise<void> {
  if (DRY_RUN) return;
  const missing = incompleteness(repro);
  if (missing.length) {
    log.warn(`reproduction said reproduced, but ${missing.join('; ')} — nothing posted on #${iid}`);
    return;
  }
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
