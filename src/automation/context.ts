/**
 * What the authoring session is handed: the ticket, the comments people wrote
 * on it, and the merged change's diff — all read here, by the conductor, over
 * the REST client every other read already uses.
 *
 * The session used to read the change itself through the GitLab MCP server.
 * That made this mode only as healthy as the server: a server that starts but
 * registers no tools leaves the session with nothing to read, and it reports
 * itself blocked after paying for the turns it took to find out. Read here,
 * the session needs no GitLab tools at all, and runner.ts starts it without
 * the server.
 *
 * Bounded on purpose. One merged MR can carry a regenerated lockfile, a
 * minified bundle or a thousand-line migration, and any one of those would
 * crowd the ticket out of the context the cases are written from. So the
 * rendering lists, but never shows, what no test case comes from (lockfiles,
 * minified, generated and binary files); keeps only a migration's head; caps
 * every file and the whole change; and marks every cut `[truncated N lines]`,
 * so neither the session nor a person reading the transcript mistakes a cut
 * diff for a whole one.
 *
 * The render half is pure. The fetch half only reads.
 */
import { isMachineNote } from '../lib/claims.js';
import {
  allIssueNotes, getIssue, getMergeRequest, issueUrl, mergeRequestDiffs, type MrDiff,
} from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import type { MrRef } from './readiness.js';

export interface TicketComment {
  author: string;
  /** ISO, as GitLab gives it. '' when GitLab gave none. */
  at: string;
  body: string;
}

/** The ticket as the prompt shows it: GitLab's own fields, and the human comments oldest first. */
export interface AutomationTicket {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  /** 'opened' or 'closed', as GitLab says it. */
  state: string;
  url: string;
  comments: TicketComment[];
}

/** One merged fix MR: what readiness named it as, the author's own description of it, and its files. */
export interface MergedChange {
  mr: MrRef;
  description: string | null;
  files: MrDiff[];
  /** false when GitLab listed more files than mergeRequestDiffs reads. */
  complete: boolean;
}

// ------------------------------------------------------------------ fetching

/**
 * getIssue + allIssueNotes. The comments kept are the ones people typed: not
 * GitLab's system notes, not any note carrying an `<!-- oneshot:` marker (this
 * mode's own notes and the Loop's), and not the Loop's unmarked `Oneshot …`
 * notes. NO document download: the Loop's fetchTicket downloads attachments
 * into state/runs/<iid>, the directory this mode must not create, and the
 * session has no file tools to open them with anyway.
 */
export async function fetchAutomationTicket(iid: number): Promise<AutomationTicket | null> {
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return null;
  const notes = await allIssueNotes(iid);
  if (!notes.ok) {
    log.warn(`auto       #${iid} could not read the ticket's comments; the session sees the description only`, { error: notes.error });
  }
  const comments = notes.ok && notes.data
    ? notes.data
      .filter((n) => !n.system && n.body && !isMachineNote(n.body) && !n.body.startsWith('Oneshot '))
      .map((n) => ({ author: n.author?.username ?? 'unknown', at: n.created_at ?? '', body: n.body }))
    : [];
  return {
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels ?? [],
    state: res.data.state,
    url: res.data.web_url || issueUrl(iid),
    comments,
  };
}

/**
 * The description and every file's diff of each MERGED MR in `merged` — the
 * readiness verdict's list, which already leaves out branch promotions and MRs
 * from other projects. Anything in it that is not merged is skipped here too,
 * so a stale list can never put an unshipped change in front of the session.
 *
 * All or nothing: a change the session sees only part of produces a list that
 * looks complete and is not. A failure is a hold for the caller, before any
 * session is paid for.
 */
export async function fetchMergedChanges(
  merged: MrRef[],
): Promise<{ ok: true; changes: MergedChange[] } | { ok: false; error: string }> {
  const changes: MergedChange[] = [];
  for (const mr of merged.filter((m) => m.state === 'merged')) {
    const got = await getMergeRequest(mr.iid);
    if (!got.ok || !got.data) return { ok: false, error: `cannot read !${mr.iid} (${got.kind} ${got.status})` };
    const diffs = await mergeRequestDiffs(mr.iid);
    if (!diffs.ok || !diffs.data) {
      return { ok: false, error: `cannot read the diff of !${mr.iid} (${diffs.kind} ${diffs.status})` };
    }
    changes.push({ mr, description: got.data.description, files: diffs.data.files, complete: diffs.data.complete });
  }
  return { ok: true, changes };
}

// ------------------------------------------------------------------ bounding

export interface DiffCaps {
  /** A longer line (minified code, an inlined blob) is cut. */
  lineChars: number;
  /** One file's diff. */
  fileLines: number;
  fileChars: number;
  /** Every shown file of every merged MR together. */
  totalLines: number;
  totalChars: number;
  /** A migration shows its head (the operations) and no more. */
  migrationLines: number;
  /** Files named across the whole change, shown or not; past this they are only counted. */
  listedFiles: number;
  /** An MR's own description. */
  descriptionLines: number;
  descriptionChars: number;
}

/**
 * About 35k tokens of diff at most. A fix MR is usually a few hundred lines,
 * so these only ever bite on the MR that would have crowded everything else out.
 */
export const DIFF_CAPS: Readonly<DiffCaps> = {
  lineChars: 400,
  fileLines: 400,
  fileChars: 30_000,
  totalLines: 2_500,
  totalChars: 120_000,
  migrationLines: 40,
  listedFiles: 300,
  descriptionLines: 80,
  descriptionChars: 6_000,
};

/** The one wording every cut uses, so a reader can search a prompt for it. */
export function truncated(n: number): string {
  return `[truncated ${n} line${n === 1 ? '' : 's'}]`;
}

/** A fence longer than any backtick run inside `text`, so no text can close it early. */
export function fenceFor(text: string): string {
  return '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
}

/** `text` in a fenced block, fenced so it cannot close itself. */
export function fenced(text: string, info = ''): string {
  const f = fenceFor(text);
  return `${f}${info}\n${text}\n${f}`;
}

/** One line: untrusted text in a heading cannot start a heading of its own. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Whole lines of `text` while both limits hold, each cut at `lineChars`, and
 * how many lines were left out. A line is never split across the limit: half a
 * hunk line reads as a change that was not made.
 */
export function clip(
  text: string, maxLines: number, maxChars: number, lineChars = Number.POSITIVE_INFINITY,
): { kept: string[]; cut: number; chars: number } {
  const lines = splitLines(text);
  const kept: string[] = [];
  let chars = 0;
  for (const raw of lines) {
    const line = raw.length > lineChars ? `${raw.slice(0, lineChars)} … [line cut at ${lineChars} of ${raw.length} chars]` : raw;
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) break;
    kept.push(line);
    chars += line.length + 1;
  }
  return { kept, cut: lines.length - kept.length, chars };
}

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock',
  'Pipfile.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'Cargo.lock', 'go.sum',
]);
const MINIFIED = /\.min\.(?:js|mjs|css)$|\.map$/i;
const GENERATED_PATH = /(?:^|\/)(?:node_modules|dist|__snapshots__)\/|\.snap$|_pb2(?:_grpc)?\.py$|\.pb\.go$/;
const BINARY = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|svg|pdf|zip|gz|tgz|tar|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|xlsx?|docx?|pptx?|odt|ods|pyc|so|dylib|dll|exe|bin|sqlite3?|db)$/i;
const MIGRATION = /(?:^|\/)migrations\/\d{4}_[^/]*\.py$/;

/** Why a file's diff is listed but not shown, or null when it is shown. No test case comes from any of these. */
export function skipReason(f: MrDiff): string | null {
  const path = f.new_path || f.old_path;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(name)) return 'lockfile';
  if (MINIFIED.test(path)) return 'minified or source map';
  if (f.generated_file === true || GENERATED_PATH.test(path)) return 'generated';
  if (BINARY.test(path) || /^Binary files .* differ$/m.test(f.diff ?? '')) return 'binary or image';
  return null;
}

export function isMigration(f: MrDiff): boolean {
  return MIGRATION.test(f.new_path || f.old_path);
}

function fileStatus(f: MrDiff): string {
  if (f.new_file) return 'new file';
  if (f.deleted_file) return 'deleted';
  if (f.renamed_file) return `renamed from ${oneLine(f.old_path)}`;
  return 'modified';
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * The merged change as prompt text: per MR its header, its description and
 * every file, shown within DIFF_CAPS. Every file is named (up to
 * `listedFiles`), so a skipped or cut one is visible as such. Pure.
 */
export function renderChanges(changes: MergedChange[], caps: DiffCaps = DIFF_CAPS): string {
  const left = { lines: caps.totalLines, chars: caps.totalChars };
  let listed = 0;
  let unlisted = 0;
  let cutTotal = 0;
  let cutFiles = 0;
  const out: string[] = [];

  for (const c of changes) {
    const m = c.mr;
    const when = m.mergedAt ? `, merged ${m.mergedAt.slice(0, 10)}` : '';
    out.push(`### !${m.iid} ${oneLine(m.title)} (${oneLine(m.source)} → ${oneLine(m.target)}${when})\n${m.url}`);

    const desc = (c.description ?? '').trim();
    if (desc) {
      const d = clip(desc, caps.descriptionLines, caps.descriptionChars, caps.lineChars);
      out.push(`#### Description of !${m.iid}\n${fenced(d.kept.join('\n'), 'text')}${d.cut ? `\n${truncated(d.cut)}` : ''}`);
    } else {
      out.push(`#### Description of !${m.iid}\n(empty)`);
    }

    out.push(`#### Files changed in !${m.iid} (${c.files.length}${c.complete ? '' : '+, more than GitLab lists here'})`);
    if (!c.files.length) out.push('(GitLab lists no changed files for this MR.)');
    for (const f of c.files) {
      if (listed >= caps.listedFiles) {
        unlisted++;
        continue;
      }
      listed++;
      const path = oneLine(f.new_path || f.old_path);
      const head = `##### !${m.iid} ${path} (${fileStatus(f)})`;
      const total = splitLines(f.diff ?? '').length;
      const skip = skipReason(f);
      if (skip) {
        out.push(`${head} — ${skip}, not shown${total ? ` (${count(total, 'line')})` : ''}`);
        continue;
      }
      if (!total) {
        out.push(`${head} — ${f.too_large || f.collapsed ? 'GitLab did not return this diff: it is too large' : 'no line changes'}`);
        continue;
      }
      const migration = isMigration(f);
      const fileLines = migration ? Math.min(caps.fileLines, caps.migrationLines) : caps.fileLines;
      const maxLines = Math.min(fileLines, left.lines);
      const maxChars = Math.min(caps.fileChars, left.chars);
      const d = maxLines > 0 && maxChars > 0
        ? clip(f.diff ?? '', maxLines, maxChars, caps.lineChars)
        : { kept: [], cut: total, chars: 0 };
      left.lines -= d.kept.length;
      left.chars -= d.chars;
      let why = '';
      if (d.cut) {
        cutTotal += d.cut;
        cutFiles++;
        why = maxLines < fileLines || maxChars < caps.fileChars
          ? ' — the diff budget for the whole change is used up'
          : migration && d.kept.length >= caps.migrationLines
            ? ' — a migration shows only its head'
            : ` — one file shows at most ${count(caps.fileLines, 'line')} or ${count(caps.fileChars, 'character')}`;
      }
      out.push(d.kept.length
        ? `${head}\n${fenced(d.kept.join('\n'), 'diff')}${d.cut ? `\n${truncated(d.cut)}${why}` : ''}`
        : `${head}\n${truncated(d.cut)}${why}`);
    }
    if (!c.complete) {
      out.push(`GitLab lists more files in !${m.iid} than are read here, so the files above are not the whole change.`);
    }
  }
  if (unlisted) out.push(`[${count(unlisted, 'more changed file')} not listed: the change names more files than are shown here]`);
  if (cutTotal) {
    out.push(`${truncated(cutTotal)} across ${count(cutFiles, 'file')} in all: the diff above is not the whole change.`);
  }
  return out.join('\n\n');
}
