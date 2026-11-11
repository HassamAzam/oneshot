/**
 * Checking that a diagnosis's evidence is where it says it is.
 *
 * A diagnosis is prose from a model, and prose about a failed run is easy to
 * write convincingly from the error text alone. That is the trap the hand
 * analysis of ticket 9174 walked out of: the error text was wrong for fifteen
 * sessions. So a finding is only as good as what it points at, and what it
 * points at is checked here, by code, after the session has ended: the file
 * exists inside the run directory or this repository, and the quoted text is in
 * it.
 *
 * The check is forgiving about position and strict about content. Models are
 * poor at line numbers and good at copying text, so a quote found a few lines
 * off, or elsewhere in the file, has its line corrected and counts. A quote
 * found nowhere does not count, whatever the line.
 *
 * Strict includes what an ellipsis may stand for. A quote may leave out its
 * middle, and then each part kept has to be long enough to mean something by
 * itself, there are at most three, and they have to sit close together on one
 * line. Without that, `r…u…n…I…d` "is found" in any journal, and so is a
 * sentence nobody wrote, assembled from three words that occur somewhere in the
 * file in that order.
 *
 * And strict about what may be cited at all: the run's own record, and this
 * repository's source. Not the diagnosis's own output, which would let a
 * finding cite the sentence that states it; and not `.env`, the state
 * directory or `node_modules`, which are not evidence of how the code behaves.
 *
 * A transcript line is JSON, so a quote is matched against the frame's decoded
 * strings: what the session actually saw, with real quotes and line breaks
 * where the raw line holds `\"` and `\n`. It is also matched against the
 * redacted form, because the peek commands a session reads transcripts through
 * redact credentials, and a quote copied from their output carries the marker.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact } from '../lib/report.js';
import { isOwnPhase } from './stop.js';
import { frameText } from './transcript.js';
import type { CheckedCitation, CheckedFinding, Citation, Finding } from './types.js';

const MIN_QUOTE = 12;
/** An elided quote: at most this many parts, each at least this long, all within this many characters of the first. */
const MAX_PARTS = 3;
const MIN_PART = 12;
const MAX_SPAN = 1500;
/** Places a first part is tried from before giving up: a frame of one repeated line has thousands. */
const MAX_STARTS = 400;
/** A quote is looked for this many lines either side of the cited one before the whole file is searched. */
const NEAR = 5;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Past this a frame is matched as written only: redacting megabytes for every quote is the conductor's time. */
const REDACT_MAX_CHARS = 200_000;
const REPO_PREFIX = 'repo:';

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** What the peek commands print around a frame's own text: their label in front, and how much they cut behind. */
const PEEK_LABEL_RE = /^(?:said:|call [\w-]+:|result(?: \([\w-]+\))?:|ERROR(?: \([\w-]+\))?:|\[stderr\]|\[result [^\]]*\])\s*/;
const PEEK_CUT_RE = /(?:…\s*)?\(\+\d+ chars\)\s*$/;

/** The quote as ordered fragments: an ellipsis in the middle stands for text left out. */
export function quoteParts(quote: string): string[] {
  const whole = flat(quote).replace(/^["'“”`]+|["'“”`]+$/g, '').replace(PEEK_CUT_RE, '');
  // The label comes off only when something is left behind it: a quote that IS the label is checked as it stands.
  const body = whole.replace(PEEK_LABEL_RE, '');
  return (body.trim() ? body : whole)
    .split(/…|\.{3,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Whether every fragment appears in `text`, in order and close together: from
 * the start of the first to the end of the last is at most `maxSpan`.
 */
export function containsQuote(text: string, parts: string[], maxSpan = MAX_SPAN): boolean {
  const head = parts[0];
  if (!head) return false;
  if (parts.length === 1) return text.includes(head);
  let start = text.indexOf(head);
  for (let tries = 0; start >= 0 && tries < MAX_STARTS; tries += 1) {
    const window = text.slice(start, start + maxSpan);
    let from = head.length;
    let all = true;
    for (const p of parts.slice(1)) {
      const at = window.indexOf(p, from);
      if (at < 0) { all = false; break; }
      from = at + p.length;
    }
    if (all) return true;
    start = text.indexOf(head, start + 1);
  }
  return false;
}

/** Why a quote cannot be checked at all, or ''. */
function tooLoose(parts: string[]): string {
  if (parts.join('').length < MIN_QUOTE) return `the quote is under ${MIN_QUOTE} characters, too short to check`;
  if (parts.length > MAX_PARTS) return `the quote leaves text out in more than ${MAX_PARTS - 1} places, too loose to check`;
  if (parts.length > 1 && parts.some((p) => p.length < MIN_PART)) {
    return `a part of the quote kept around an ellipsis is under ${MIN_PART} characters, too loose to check`;
  }
  return '';
}

export interface Roots {
  /** The run directory: state/runs/<iid>. */
  run: string;
  /** The Oneshot repository root, for `repo:` citations. */
  repo: string;
}

/**
 * Resolve a cited file to a path inside one of the two roots, or null.
 *
 * Inside, checked after resolving and again after following links: a citation
 * is model output, and neither `../../etc/passwd` nor a link that points there
 * is read on its say-so.
 */
export function resolveCited(file: string, roots: Roots): string | null {
  // Links followed as far as the path exists, so a file that is merely absent
  // is "no such file" and not "outside": on macOS a temp directory is itself
  // reached through a link.
  const real = (p: string): string => {
    const rest: string[] = [];
    for (let at = resolve(p); ; at = dirname(at)) {
      try { return join(realpathSync(at), ...rest); } catch { /* not there: try its parent */ }
      if (dirname(at) === at) return resolve(p);
      rest.unshift(basename(at));
    }
  };
  const within = (root: string, rel: string): string | null => {
    const full = resolve(root, rel);
    const back = relative(resolve(root), full);
    if (back === '' || back.startsWith('..') || isAbsolute(back)) return null;
    const through = relative(real(root), real(full));
    return through === '' || through.startsWith('..') || isAbsolute(through) ? null : full;
  };
  const f = file.trim();
  if (!f) return null;
  if (f.startsWith(REPO_PREFIX)) return within(roots.repo, f.slice(REPO_PREFIX.length).replace(/^\/+/, ''));
  if (isAbsolute(f)) {
    for (const root of [roots.run, roots.repo]) {
      const r = resolve(root);
      if (f === r || f.startsWith(r + sep)) return within(root, relative(r, f));
    }
    return null;
  }
  return within(roots.run, f);
}

/** Top-level names of the repository that hold no source: secrets, state, dependencies. */
const NOT_SOURCE = new Set(['state', 'state-dry', 'node_modules', '.git']);

/**
 * Why a file that resolved is still not evidence, or ''.
 *
 * In the run directory: the diagnosis's own record, its own session's output
 * and its own transcripts. The digest (`diagnosis/evidence.json`) stays
 * citable: code wrote it, from the run. In the repository: anything that is
 * not source.
 */
export function notCitable(path: string, roots: Roots): string {
  const inRun = relative(resolve(roots.run), path);
  if (inRun && !inRun.startsWith('..') && !isAbsolute(inRun)) {
    const rel = inRun.split(sep).join('/');
    const own = /^transcripts\/(.+)-lap\d+\.jsonl$/.exec(rel);
    if (rel === 'diagnosis.json' || (rel.startsWith('diagnosis/') && rel !== 'diagnosis/evidence.json') || (own && isOwnPhase(own[1]!))) {
      return 'a diagnosis cannot cite its own output';
    }
    return '';
  }
  const inRepo = relative(resolve(roots.repo), path).split(sep);
  if (NOT_SOURCE.has(inRepo[0] ?? '') || basename(path).startsWith('.env')) return 'not a file of the repository\'s source';
  return '';
}

interface Loaded { lines: string[]; jsonl: boolean; decoded: Map<number, string[]> }

function load(path: string, cache: Map<string, Loaded | null>): Loaded | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  let out: Loaded | null = null;
  try {
    if (existsSync(path) && statSync(path).isFile() && statSync(path).size <= MAX_FILE_BYTES) {
      out = { lines: readFileSync(path, 'utf8').split('\n'), jsonl: path.endsWith('.jsonl'), decoded: new Map() };
    }
  } catch { /* unreadable is the same as absent */ }
  cache.set(path, out);
  return out;
}

/**
 * The texts a quote may match for one line: as written for a text file; for a
 * transcript, the frame's decoded strings, and those strings as a redacting
 * reader shows them. Kept as SEPARATE texts: joined, a quote's fragments could
 * be found one in each copy and match in an order the line never had.
 */
function formsAt(f: Loaded, index: number): string[] {
  const raw = f.lines[index];
  if (raw === undefined) return [];
  if (!f.jsonl) return [flat(raw)];
  const had = f.decoded.get(index);
  if (had) return had;
  let text = raw;
  let label = '';
  try {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    text = frameText(frame);
    // A result frame's outcome, as its own JSON spells it and as the peek commands print it.
    if (frame.type === 'result') label = `"subtype":"${String(frame.subtype ?? '')}" [result ${String(frame.subtype ?? '')} turns=${String(frame.num_turns ?? 0)}]`;
  } catch { /* a cut-off line is matched as it stands */ }
  const seen = flat(text);
  const shown = seen.length <= REDACT_MAX_CHARS ? redact(seen) : seen;
  const out = shown === seen ? [seen] : [seen, shown];
  if (label) out.push(label);
  f.decoded.set(index, out);
  return out;
}

const lineHas = (f: Loaded, index: number, parts: string[]): boolean => formsAt(f, index).some((t) => containsQuote(t, parts));

export function checkCitation(c: Citation, roots: Roots, cache: Map<string, Loaded | null> = new Map()): CheckedCitation {
  const bad = (note: string): CheckedCitation => ({ ...c, ok: false, note });
  const parts = quoteParts(c.quote ?? '');
  const loose = tooLoose(parts);
  if (loose) return bad(loose);

  const path = resolveCited(String(c.file ?? ''), roots);
  if (!path) return bad('the file is outside the run directory and this repository');
  const barred = notCitable(path, roots);
  if (barred) return bad(barred);
  const f = load(path, cache);
  if (!f) return bad('no such file');

  const at = Math.max(0, Math.trunc(Number(c.line) || 1) - 1);
  if (lineHas(f, at, parts)) return { ...c, ok: true, note: '' };

  // A text file's quote can run across lines; a transcript's cannot leave its frame.
  if (!f.jsonl) {
    const window = f.lines.slice(Math.max(0, at - NEAR), at + NEAR + 1).map(flat).join(' ');
    if (containsQuote(window, parts)) return { ...c, ok: true, note: '' };
  }

  for (let d = 1; d <= NEAR; d += 1) {
    for (const i of [at - d, at + d]) {
      if (i >= 0 && i < f.lines.length && lineHas(f, i, parts)) {
        return { ...c, line: i + 1, ok: true, note: `found at line ${i + 1}, not ${at + 1}` };
      }
    }
  }
  for (let i = 0; i < f.lines.length; i += 1) {
    if (lineHas(f, i, parts)) return { ...c, line: i + 1, ok: true, note: `found at line ${i + 1}, not ${at + 1}` };
  }
  // The whole file as one text, for a quote that runs across more lines than the
  // window above. Never for an elided one: three parts "in order somewhere in
  // the file" is true of almost any three parts.
  if (!f.jsonl && parts.length === 1) {
    // Pretty-printed JSON escapes quotes and line breaks, so try its decoded strings too.
    const whole = f.lines.join('\n');
    let decoded = '';
    try { decoded = flat(frameText(JSON.parse(whole))); } catch { /* not JSON */ }
    if (containsQuote(flat(whole), parts) || (decoded && containsQuote(decoded, parts))) {
      return { ...c, ok: true, note: 'found in the file, across lines' };
    }
  }
  return bad('the quote is not in that file');
}

/**
 * Check every citation of every finding.
 *
 * `evidenced` is true when at least one of a finding's citations holds. One is
 * enough: a finding often cites the journal for what was recorded and a
 * transcript for what happened, and a slip in one does not unmake the other.
 */
export function checkFindings(findings: Finding[], roots: Roots): { findings: CheckedFinding[]; checked: number; verified: number } {
  const cache = new Map<string, Loaded | null>();
  let checked = 0;
  let verified = 0;
  const out = findings.map((f): CheckedFinding => {
    const evidence = (Array.isArray(f.evidence) ? f.evidence : []).map((c) => checkCitation(c, roots, cache));
    checked += evidence.length;
    verified += evidence.filter((e) => e.ok).length;
    return { ...f, evidence, evidenced: evidence.some((e) => e.ok) };
  });
  return { findings: out, checked, verified };
}

/** `repo:src/x.ts` → `src/x.ts`; anything else unchanged. */
export function displayFile(file: string): string {
  return file.startsWith(REPO_PREFIX) ? file.slice(REPO_PREFIX.length) : file;
}

export function isRepoCitation(file: string): boolean {
  return file.startsWith(REPO_PREFIX);
}
