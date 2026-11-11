/**
 * The diagnosis as a GitLab comment, and the comment that follows when a fix is
 * opened for it.
 *
 * Rendered by code from the checked diagnosis, never written by the session,
 * for the reason publish.ts gives for every other note: session phases hold no
 * GitLab write tool. Rendering here also means what reaches the ticket is what
 * survived the citation check, with the unproven parts marked as such.
 *
 * Three things on a ticket READ its comments, and a note that quotes a failed
 * run can trip all of them:
 *
 *   - The claim protocol (src/lib/claims.ts) takes "claimed this ticket — run
 *     `r-…`" as a claim and "Oneshot stopped" beside a run id as that run's
 *     end. A parked run's claim is live; a diagnosis quoting the stop note
 *     would kill it, and another desk would take the ticket.
 *   - GitLab runs quick actions (`/close`, `/label`) at the start of any line
 *     of an API-created note, and notifies whoever an `@name` names.
 *   - The review gates read every comment that is not a machine note as a
 *     reviewer speaking. The marker at the bottom is what makes this one a
 *     machine note.
 *
 * So every piece of model- or run-written text goes through `inert()` on its
 * way in. That alone is not the guarantee, because the pieces are cut, flattened
 * and joined afterwards, and "Oneshot\nstopped" becomes the phrase only once
 * its line break is collapsed. The guarantee is `seal()`: the finished note is
 * read by the claim protocol's own parsers before it is returned, and a note
 * they would act on is never returned.
 */
import { parseClaims, stoppedRuns } from '../lib/claims.js';
import type { IssueNote } from '../lib/gitlab.js';
import { codeSpan, mdText, tableCell } from '../lib/gitlabmd.js';
import { redact } from '../lib/report.js';
import { inertNoteText } from '../mrfeedback/respond.js';
import { displayFile } from './citations.js';
import type { Category, CheckedFinding, FixBy, FixRecord, StopDiagnosis } from './types.js';

const MAX_FINDINGS = 8;
const CAUSE_CHARS = 1200;
const SOLUTION_CHARS = 900;
const ACCOUNT_CHARS = 3500;
const QUOTE_CHARS = 300;

export function diagnosisMarker(key: string): string {
  return `<!-- oneshot:diagnosis:${key.replace(/[^\w-]/g, '')} -->`;
}

export function fixMarker(key: string, findingId: string): string {
  return `<!-- oneshot:diagnosis-fix:${key}:${findingId.replace(/[^\w-]/g, '')} -->`;
}

/** A pull request on GitHub, or ''. The only kind of address a note prints as given. */
export function prLink(url: string | undefined): string {
  return url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) ? url : '';
}

/** The three phrases src/lib/claims.ts acts on, in any spacing: a later step may collapse it. */
function defuse(text: string): string {
  return text
    .replace(/claimed(\s+)this(\s+)ticket\s*—\s*run/gi, 'claimed$1this$2ticket, run')
    .replace(/Oneshot(\s+)stopped/gi, 'Oneshot$1halted')
    .replace(/—(\s*)complete/gi, '-$1complete');
}

/**
 * Text from a session or a run, made safe to stand in a ticket comment:
 * credentials out, no line that GitLab would run as a command, nobody
 * notified, and none of the three phrases the claim protocol parses.
 */
export function inert(text: string): string {
  return defuse(inertNoteText(redact(text))).replace(/<!--/g, '<! --');
}

/** Whether the claim protocol would act on a comment with this body: take it as a claim, or as a run ending. */
export function readsAsClaimOrStop(body: string): boolean {
  const notes = [{ id: 1, body, system: false, created_at: new Date(0).toISOString() }] as unknown as IssueNote[];
  return parseClaims(notes).length > 0 || stoppedRuns(notes).size > 0;
}

/**
 * The finished note, with its marker, guaranteed inert to the claim protocol.
 *
 * Checked with the protocol's own functions and not with a copy of its
 * patterns, so a phrase added there tomorrow is caught here without anyone
 * remembering this file. The fallbacks are blunt on purpose: a note that reads
 * a little oddly is nothing beside a live run losing its ticket.
 */
function seal(lines: string[], marker: string): string {
  // Once more over the whole of it, for whatever reached a line without going
  // through inert(): no line starts with a command, and nobody is notified.
  let body = defuse(inertNoteText(lines.join('\n')));
  if (readsAsClaimOrStop(body)) body = body.replace(/—/g, '-').replace(/stopped/gi, 'halted').replace(/claimed/gi, 'took');
  if (readsAsClaimOrStop(body)) {
    body = 'A diagnosis of this run was made and could not be written here safely. It is in the run directory and on the dashboard.';
  }
  return `${body}\n\n${marker}`;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const prose = (s: string, n: number): string => mdText(inert(cut((s ?? '').trim(), n)));
/**
 * Inline code. Flattened BEFORE it is made inert, so nothing is assembled out
 * of a line break afterwards. A span never starts a line of the note, so the
 * guard against a leading slash is taken back off: with it, a path copied out
 * of the comment carries a character nobody can see.
 */
const span = (s: string): string => codeSpan(inert((s ?? '').replace(/\s+/g, ' ').trim()).replace(/^\u200B\//, '/'));

const WHOSE: Record<Category, string> = {
  harness: 'Oneshot (harness)', environment: 'this machine', ticket: "the ticket's change", human: 'a decision',
};
const BY: Record<FixBy, string> = {
  pr: 'a pull request on Oneshot', operator: 'an operator, on the machine', pipeline: 'the pipeline, from an earlier phase', person: 'a person deciding',
};

function tallyLine(findings: CheckedFinding[]): string {
  const n = (c: Category): number => findings.filter((f) => f.category === c).length;
  const bits = [
    n('harness') ? `${n('harness')} in the harness` : '',
    n('environment') ? `${n('environment')} on this machine` : '',
    n('ticket') ? `${n('ticket')} in the ticket's own change` : '',
    n('human') ? `${n('human')} waiting on a decision` : '',
  ].filter(Boolean);
  return bits.join(', ');
}

function fixLine(fix: FixRecord | undefined): string {
  if (!fix) return '';
  if (fix.state === 'opened' && prLink(fix.prUrl)) return ` — fix opened: ${prLink(fix.prUrl)}`;
  return fix.why ? ` — no pull request: ${inert(cut(fix.why, 200))}` : '';
}

function findingBlock(f: CheckedFinding, decisive: boolean, fix: FixRecord | undefined): string {
  const lines: string[] = [];
  lines.push(`<details><summary><b>${mdText(inert(cut(f.id, 12)))}</b>${decisive ? ' ★' : ''} · ${f.category} · ${mdText(inert(cut(f.title, 120)))}</summary>`, '');
  if (f.phases) lines.push(`**Affected:** ${prose(f.phases, 300)}`, '');
  if (f.recorded) lines.push(`**Recorded as:** ${span(cut(f.recorded, 240))}`, '');
  lines.push(`**What happened:** ${prose(f.cause, CAUSE_CHARS)}`, '');
  lines.push('**Evidence**');
  for (const c of f.evidence) {
    const at = `${displayFile(c.file)}:${c.line}`;
    lines.push(c.ok
      ? `- ${span(at)} ${span(cut(c.quote, QUOTE_CHARS))}`
      : `- ~~${span(at)}~~ not confirmed: ${inert(c.note)}`);
  }
  lines.push('', `**Fix (${BY[f.fix]}):** ${prose(f.solution, SOLUTION_CHARS)}${fixLine(fix)}`);
  if (f.fixedBy) lines.push('', `**Already fixed** in the checkout this was diagnosed against, by commit ${span(f.fixedBy)}. Run code that has it.`);
  if (f.where.length) lines.push('', `**Where:** ${f.where.slice(0, 8).map((w) => span(cut(w, 160))).join(', ')}`);
  lines.push('', '</details>');
  return lines.join('\n');
}

export interface NoteContext {
  /** A link to the run on the fleet dashboard, when this desk has a reachable one. */
  dashboardUrl?: string;
}

/**
 * The comment for one diagnosed stop.
 *
 * Findings whose evidence did not check out are listed apart, as leads, and
 * said to be unproven: dropping them would hide what the session suspected,
 * and listing them as findings would be passing on a guess.
 */
export function renderDiagnosisNote(d: StopDiagnosis, ctx: NoteContext = {}): string {
  const all = d.findings ?? [];
  const findings = all.filter((f) => f.evidenced);
  const leads = all.filter((f) => !f.evidenced);
  const shown = findings.slice(0, MAX_FINDINGS);
  const out: string[] = [];

  out.push(`**Oneshot diagnosis** — ${prose(d.headline ?? '', 300)}`, '');
  const where = `Run ${span(d.runId)} is ${d.status === 'parked' ? 'waiting at a gate' : 'blocked'} at ${span(d.stoppedPhase || 'an unrecorded phase')}.`;
  out.push(findings.length ? `${where} ${findings.length} cause(s) found: ${tallyLine(findings)}.` : `${where} No cause could be shown with evidence.`, '');

  if (d.nextStep) {
    // Said once: a next step that already ends in "resume from implement" is not followed by it again.
    const said = !!d.resumeFrom && new RegExp(`resum[^.]{0,120}${d.resumeFrom.replace(/[^\w-]/g, '')}`, 'i').test(d.nextStep);
    out.push(`**What to do next:** ${prose(d.nextStep, 1500)}`
      + (d.resumeFrom && !said ? ` Then resume the run from ${span(d.resumeFrom)}.` : ''), '');
  }
  if (shown.length) {
    out.push('| | Cause | Whose | Fixed by |', '|---|---|---|---|');
    for (const f of shown) {
      const fix = d.fixes?.[f.id];
      const by = f.fixedBy ? `already fixed by ${span(f.fixedBy)}: deploy it` : BY[f.fix];
      out.push(`| ${tableCell(inert(f.id))}${f.id === d.decisive ? ' ★' : ''} | ${tableCell(inert(cut(f.title, 120)))} | ${WHOSE[f.category]} | `
        + `${by}${fix?.state === 'opened' && prLink(fix.prUrl) ? ` — ${prLink(fix.prUrl)}` : ''} |`);
    }
    out.push('', '★ is the one that stops the next attempt too.', '');
  }
  if (d.account) out.push('**What happened**', '', prose(d.account, ACCOUNT_CHARS), '');
  if (shown.length) {
    for (const f of shown) out.push(findingBlock(f, f.id === d.decisive, d.fixes?.[f.id]), '');
    if (findings.length > shown.length) out.push(`_${findings.length - shown.length} more cause(s) are on the dashboard._`, '');
  }

  if (leads.length) {
    out.push('**Leads, not findings.** The evidence cited for these could not be found where it was said to be, so treat them as unproven:');
    for (const f of leads.slice(0, 6)) out.push(`- ${mdText(inert(cut(f.title, 140)))} (${f.category})`);
    out.push('');
  }

  const c = d.citations;
  const count = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const read = d.read
    ? ` and ${count(d.read.transcripts)} transcript(s) (${Math.max(1, Math.round(count(d.read.transcriptBytes) / (1024 * 1024)))} MB)`
    : ' and transcripts';
  // An operator's setting, and still a string that ends up on a ticket: an address or nothing.
  const link = ctx.dashboardUrl && /^https?:\/\/[^\s()<>"'`]+$/.test(ctx.dashboardUrl) ? ctx.dashboardUrl : '';
  out.push(`_Read from the run's journal${read}.`
    + (c ? ` ${count(c.verified)} of ${count(c.checked)} citations were re-opened and found.` : '')
    + ' Nothing was changed: this is a diagnosis, not a repair.'
    + (link ? ` [Open on the dashboard](${link}).` : '') + '_');
  return seal(out, diagnosisMarker(d.key));
}

/**
 * The comment that follows a diagnosis when a fix pull request has been opened.
 *
 * Says what was measured and by whom. "Verified" here means the pipeline ran
 * the checks itself; the sentence names each one so a reader can tell that
 * from a session vouching for its own work.
 */
export function renderFixNote(o: { key: string; finding: Pick<CheckedFinding, 'id' | 'title'>; fix: FixRecord }): string {
  const { fix, finding } = o;
  const out: string[] = [];
  out.push(`**Fix opened for ${mdText(inert(cut(finding.id, 12)))}** — ${prLink(fix.prUrl) || '(no pull request address was recorded)'}`, '');
  out.push(`It addresses: ${mdText(inert(cut(finding.title, 160)))}`, '');
  if (fix.checks) {
    out.push('Checked by the pipeline itself, not taken from the author:');
    out.push(`- reproduction: ${inert(fix.checks.redGreen)}`);
    out.push(`- typecheck: ${inert(fix.checks.typecheck)}`);
    out.push(`- tests: ${inert(fix.checks.tests)}`);
    if (fix.checks.hooks) out.push(`- hooks: ${inert(fix.checks.hooks)}`);
    out.push('');
  }
  if (fix.review) {
    const r = fix.review;
    out.push(`Reviewed by two independent reviewers and then an adversarial verifier: ${r.raised} point(s) raised, `
      + `${r.upheld} upheld${r.upheld ? ` and ${r.fixed} of those fixed` : ''}, ${r.refuted} refuted, over ${r.rounds} round(s).`, '');
  }
  out.push('It is not merged. A person reviews and merges it.');
  return seal(out, fixMarker(o.key, finding.id));
}
