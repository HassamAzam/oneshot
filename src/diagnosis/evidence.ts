/**
 * Everything a stopped run left behind, boiled down to what explains the stop.
 *
 * The diagnosis session is a model, and a run directory is tens of megabytes:
 * ticket 9174's was 22 MB, 18 of it transcripts. Handing a session that
 * directory and asking "what went wrong" spends its whole budget on reading and
 * leaves it trusting the first error text it meets. So the reading is done
 * here, in code, once: this file turns the directory into a digest of a few
 * thousand lines at most, and the session starts from the digest.
 *
 * What goes in is chosen by what misled a person reading that run by hand.
 *
 * The journal's error text is not what the session said. Fifteen sessions were
 * recorded as "Claude Code process exited with code 1". Two had run out of
 * structured-output tries and one out of turns; most of the rest had finished
 * successfully and the CLI had exited afterwards. Every one of those is a
 * disagreement between `run.json` and the first result frame of the
 * transcript, and a disagreement between two files is something code can find.
 * They are the `facts` below, each with the line that shows it.
 *
 * A failure that happens in one session is that session's. The same failure in
 * nine sessions across four phases is the machine's or the harness's. A git
 * fetch that could not authenticate and a Postgres role that was refused both
 * appeared in almost every transcript of that run, and no single phase's error
 * said so. Grouping failed tool calls across the whole run is what shows it,
 * and those are the `signals`.
 *
 * A session started with no tools is not reported by anything: the SDK says the
 * MCP server is connected, and the phase works around the missing tools or
 * blocks on them three hours later. The init frame lists the tools, so it is
 * counted.
 *
 * Nothing here concludes anything. Every entry is an observation with a
 * position, stated so the session can cite it and src/diagnosis/citations.ts
 * can check the citation afterwards.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../lib/report.js';
import type { PhaseRecord, RunJournal } from '../lib/artifacts.js';
import { CODE_REPEATS, SESSION_REPEATS, countsAsRun, isOwnPhase, isRerecord } from './stop.js';
import { scanTranscript, type RawSignal, type Session, type SignalKind } from './transcript.js';

const isOwn = isOwnPhase;

const REASON_CHARS = 6000;
const ERROR_CHARS = 400;
const FIELD_CHARS = 700;
const MAX_GROUPS = 30;
const MAX_LOG_GROUPS = 30;
const LOG_TAIL = 25;

// ---------------------------------------------------------------------- shape

export interface PhasePolicy {
  kind: string;
  onFail: string;
  maxTurns?: number;
  timeoutMin?: number;
  maxLaps?: number;
  maxRetries?: number;
  cycleTo?: string;
}

export interface DbPhaseRun {
  phase: string; lap: number; status: string; started_at: number; ended_at: number | null;
  turns: number | null; weighted: number | null; detail: string | null;
}
export interface DbEvent { ts: number; kind: string; phase: string | null; detail: string | null }

export interface EvidenceInputs {
  /** A run directory: state/runs/<iid>, or a copy of one. */
  dir: string;
  /**
   * The journal, when the caller has already read it and decided from it.
   * Default: `run.json` in `dir`. A run parked at a gate is re-claimed every
   * tick, so a second read can land on `running` with no reason.
   */
  journal?: RunJournal;
  /** config/phases.json by phase name, so a cap that was hit can be told from a number that was merely high. */
  policy?: Record<string, PhasePolicy>;
  /** This run's rows from state/oneshot.db. Absent on a copied directory. */
  db?: { phaseRuns: DbPhaseRun[]; events: DbEvent[] };
  /** The conductor's log for the run's window, or why there is none. */
  log?: { lines: string[]; source: string } | { unavailable: string };
  now?: number;
}

export interface Attempt {
  id: string;
  phase: string;
  /** First lap of the row, and the last when identical records were folded into it. */
  lap: number;
  lapTo: number;
  /** How many journal records this row stands for. */
  times: number;
  status: string;
  startedAt: number;
  endedAt: number;
  turns: number | null;
  weighted: number | null;
  /** The error text the journal recorded: what the ticket and the dashboard showed. */
  recorded: string;
  transcript: string | null;
}

export interface PhaseSummary {
  phase: string;
  records: number;
  /** Times the phase ran: not a poll that found a person had not acted, and not the conductor's second record of one session. */
  ran: number;
  byStatus: Record<string, number>;
  minutes: number;
  weighted: number;
  policy: string;
}

export type FactKind =
  | 'masked-error' | 'finished-then-exit' | 'no-result' | 'turn-cap' | 'structured-output'
  | 'trailing-frame' | 'mcp-no-tools' | 'mcp-not-connected' | 'compacted' | 'repeated'
  | 'unrecorded' | 'every-failure-says';

export interface Cite { file: string; line: number }

export interface Fact {
  id: string;
  kind: FactKind;
  phase: string;
  text: string;
  cites: Cite[];
}

export interface SignalGroup {
  id: string;
  kind: SignalKind;
  /** The line the group is keyed on, normalised. */
  key: string;
  count: number;
  /** Transcripts it occurred in, with how often. */
  files: Array<{ file: string; count: number }>;
  tool: string;
  /** The first occurrence: what was called and what came back. */
  call: string;
  text: string;
  cites: Cite[];
}

export interface TranscriptSummary {
  file: string;
  phase: string;
  lap: number;
  bytes: number;
  lines: number;
  skipped?: string;
  sessions: Array<Pick<Session, 'line' | 'model' | 'resumed' | 'tools' | 'mcp' | 'assistantFrames' | 'settled' | 'trailing' | 'compactions' | 'lastSaid' | 'structuredCalls' | 'structuredRejects'>>;
  /** The last failed calls before the file ends: usually the nearest thing to a cause of death. */
  lastErrors: Array<{ line: number; kind: SignalKind; tool: string; call: string; text: string }>;
}

/** What each lap of one phase returned, for a phase that ran more than once. */
export interface LapOutputs {
  phase: string;
  laps: Array<{ lap: number; file: string; line: number; subtype: string; turns: number; output: string }>;
}

export interface ArtifactBrief { file: string; bytes: number; modifiedAt: number; fields: Record<string, string> }
export interface GateBrief { gate: string; approved: boolean; rounds: number; standing: boolean }
export interface EventSummary { kind: string; count: number; firstAt: number; lastAt: number; sample: string }

export interface Evidence {
  generatedAt: number;
  run: {
    iid: number; runId: string; title: string; url: string; status: string;
    stoppedPhase: string; createdAt: number; stoppedAt: number;
    /** The stop reason as the journal holds it: what the ticket's stop note says. */
    reason: string;
    reviewMode: boolean; branch: string; worktree: string; baseSha: string;
    mrIid: number | null; mrUrl: string;
    remediations: Array<{ phase: string; category: string; fixed: boolean; reason: string; changes: string[] }>;
    decisions: string[];
  };
  totals: { records: number; transcripts: number; transcriptBytes: number; sessions: number; weighted: number; minutes: number };
  phases: PhaseSummary[];
  attempts: Attempt[];
  facts: Fact[];
  /** Lap by lap, what a repeated phase's own result frames said. */
  lapOutputs: LapOutputs[];
  signals: SignalGroup[];
  transcripts: TranscriptSummary[];
  artifacts: ArtifactBrief[];
  gates: GateBrief[];
  events: EventSummary[];
  log: { source: string; unavailable?: string; groups: Array<{ text: string; count: number }>; tail: string[] };
}

// -------------------------------------------------------------------- helpers

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clipped = (s: unknown, n: number): string => {
  const t = flat(typeof s === 'string' ? s : JSON.stringify(s ?? '') ?? '');
  return redact(t.length > n ? `${t.slice(0, n)}…` : t);
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * A line with what varies between two occurrences of the same failure taken
 * out: counts, hashes, and the directories a path sits under.
 */
export function normaliseLine(line: string): string {
  return flat(line)
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, 'H')
    .replace(/(?:\/[\w.@+~-]+){2,}/g, (p) => `…/${p.split('/').pop() ?? ''}`)
    .replace(/\d+/g, 'N');
}

/**
 * Lines that open nearly every failed command of a run and so name none of
 * them: a shell start-up complaint, the `Exit code` line. A line counts when it
 * appears in at least half of the failures, and there are enough failures for
 * "half" to mean something.
 */
export function chatterLines(texts: string[]): Set<string> {
  const MIN_FAILURES = 6;
  const out = new Set<string>();
  if (texts.length < MIN_FAILURES) return out;
  const seen = new Map<string, number>();
  for (const t of texts) {
    for (const l of new Set(t.split('\n').map(normaliseLine).filter(Boolean))) seen.set(l, (seen.get(l) ?? 0) + 1);
  }
  for (const [l, n] of seen) if (n * 2 >= texts.length) out.add(l);
  return out;
}

/** The Bash tool's own first line on a failed command. It names nothing, on any machine. */
const EXIT_LINE_RE = /^exit code n$/i;
const isNoise = (normalised: string, chatter: Set<string>): boolean => chatter.has(normalised) || EXIT_LINE_RE.test(normalised);

/** What a failure is grouped by: its first line that is not chatter. */
export function signalKey(text: string, chatter: Set<string>): string {
  const lines = text.split('\n').map(normaliseLine).filter(Boolean);
  const first = lines.find((l) => !isNoise(l, chatter)) ?? lines[0] ?? '';
  return first.slice(0, 160);
}

/** The part of a failure worth showing: its lines with the chatter taken out. */
function meaningful(text: string, chatter: Set<string>): string {
  const lines = text.split('\n').filter((l) => { const n = normaliseLine(l); return n !== '' && !isNoise(n, chatter); });
  return flat((lines.length ? lines : text.split('\n')).join(' ')).slice(0, 320);
}

function policyText(p: PhasePolicy | undefined): string {
  if (!p) return '';
  const bits = [p.kind];
  if (p.maxTurns) bits.push(`maxTurns ${p.maxTurns}`);
  if (p.timeoutMin) bits.push(`timeout ${p.timeoutMin}m`);
  bits.push(`onFail ${p.onFail}${p.cycleTo ? `→${p.cycleTo}` : ''}`);
  if (p.maxLaps !== undefined) bits.push(`maxLaps ${p.maxLaps}`);
  if (p.maxRetries !== undefined) bits.push(`maxRetries ${p.maxRetries}`);
  return bits.join(', ');
}

/** The SDK's and the CLI's own words for the process ending. A session's own "…dev server process exited with code 1" is not this. */
const CRASH_TEXT_RE = /Claude Code process exited with code|error_during_execution|only prompt commands/i;
const NONE: Set<string> = new Set();

// -------------------------------------------------------------------- journal

function foldAttempts(records: PhaseRecord[], transcripts: Set<string>): Attempt[] {
  const out: Attempt[] = [];
  for (const r of records) {
    const file = `transcripts/${r.phase}-lap${r.lap}.jsonl`;
    const transcript = transcripts.has(file) ? file : null;
    const recorded = clipped(r.error ?? '', ERROR_CHARS);
    const prev = out[out.length - 1];
    // Only records with nothing to tell apart are folded: a code phase that ran
    // again and said the same thing. A session lap always keeps its own row.
    if (prev && !transcript && !prev.transcript && prev.phase === r.phase && prev.status === r.status
      && prev.recorded === recorded && prev.lapTo + 1 === r.lap) {
      prev.lapTo = r.lap;
      prev.times += 1;
      prev.endedAt = r.endedAt;
      prev.weighted = (prev.weighted ?? 0) + (r.weighted ?? 0) || null;
      continue;
    }
    out.push({
      id: '', phase: r.phase, lap: r.lap, lapTo: r.lap, times: 1, status: r.status,
      startedAt: r.startedAt, endedAt: r.endedAt,
      turns: r.turns ?? null, weighted: r.weighted ?? null, recorded, transcript,
    });
  }
  out.forEach((a, i) => { a.id = `A${i + 1}`; });
  return out;
}

function summarisePhases(records: PhaseRecord[], policy: Record<string, PhasePolicy>): PhaseSummary[] {
  const by = new Map<string, PhaseSummary>();
  const before = new Map<string, PhaseRecord>();
  for (const r of records) {
    const s = by.get(r.phase)
      ?? { phase: r.phase, records: 0, ran: 0, byStatus: {}, minutes: 0, weighted: 0, policy: policyText(policy[r.phase]) };
    s.records += 1;
    s.byStatus[r.status] = (s.byStatus[r.status] ?? 0) + 1;
    // The conductor's verdict on a session it already recorded repeats that
    // session's time and tokens: counted once, and one run of the phase.
    if (!isRerecord(before.get(r.phase), r)) {
      if (countsAsRun(r.status)) s.ran += 1;
      s.minutes += Math.max(0, r.endedAt - r.startedAt) / 60_000;
      s.weighted += r.weighted ?? 0;
    }
    before.set(r.phase, r);
    by.set(r.phase, s);
  }
  return [...by.values()].map((s) => ({ ...s, minutes: Math.round(s.minutes) }));
}

function gatesOf(j: RunJournal): GateBrief[] {
  const named: Array<[string, RunJournal['planApproval']]> = [
    ['design', j.designApproval], ['plan', j.planApproval], ['testcases', j.testcasesApproval],
    ['not-a-bug', j.notABugApproval], ['verify-cases', j.verifyCasesApproval],
  ];
  return named.filter(([, s]) => !!s).map(([gate, s]) => ({
    gate,
    approved: s!.approved === true,
    rounds: (s!.feedback ?? []).length,
    standing: s!.requestNoteId != null && s!.approved !== true,
  }));
}

// ------------------------------------------------------------------ artifacts

const SCALARS = ['summary', 'blocked', 'verdict', 'category', 'fixed', 'status', 'retryFrom', 'diagnosis', 'humanNeeded', 'lintClean'];

function artifactBrief(dir: string, file: string): ArtifactBrief | null {
  const path = join(dir, file);
  let bytes = 0;
  let modifiedAt = 0;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    bytes = st.size;
    modifiedAt = st.mtimeMs;
  } catch {
    return null;
  }
  const fields: Record<string, string> = {};
  const data = bytes < 2 * 1024 * 1024 ? readJson<Record<string, unknown>>(path) : null;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of SCALARS) {
      const v = data[k];
      if (v === null || v === undefined || v === '') continue;
      fields[k] = clipped(v, FIELD_CHARS);
    }
    const findings = data.findings;
    if (Array.isArray(findings)) {
      fields.findings = `${findings.length}: ` + findings.slice(0, 12).map((f) => {
        const x = f as Record<string, unknown>;
        return `${String(x.id ?? '?')} [${String(x.severity ?? '?')}] ${clipped(x.title ?? x.what ?? '', 120)}`;
      }).join(' | ');
    }
    const results = data.results;
    if (Array.isArray(results)) {
      const tally = new Map<string, number>();
      for (const r of results) {
        const k = String((r as Record<string, unknown>).result ?? '?');
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
      fields.results = [...tally].map(([k, n]) => `${n} ${k}`).join(', ');
      const bad = results.filter((r) => !['pass', 'passed'].includes(String((r as Record<string, unknown>).result)));
      if (bad.length) {
        fields.notPassing = bad.slice(0, 8).map((r) => {
          const x = r as Record<string, unknown>;
          return `${String(x.id ?? '?')} (${String(x.result ?? '?')}): ${clipped(x.evidence ?? '', 260)}`;
        }).join(' | ');
      }
    }
    for (const k of ['cases', 'steps', 'commits', 'filesChanged', 'changes', 'regressions']) {
      const v = data[k];
      if (Array.isArray(v) && v.length) fields[k] = `${v.length} item(s)`;
    }
  }
  return { file, bytes, modifiedAt, fields };
}

// ---------------------------------------------------------------------- facts

interface Scanned { file: string; phase: string; lap: number; scan: ReturnType<typeof scanTranscript> }

/** One session as the journal means it: its first init, and any resume phase.ts made of it to recover its output. */
type Chain = Session[];

function chainsOf(sessions: Session[]): Chain[] {
  const out: Chain[] = [];
  const byId = new Map<string, Chain>();
  for (const s of sessions) {
    const open = s.resumed && s.sessionId ? byId.get(s.sessionId) : undefined;
    if (open) { open.push(s); continue; }
    const c: Chain = [s];
    out.push(c);
    if (s.sessionId) byId.set(s.sessionId, c);
  }
  return out;
}

/**
 * What a session finally reported: the segment that succeeded when one did
 * (a resume that recovered the structured output), otherwise the first that
 * settled at all. A failed resume has four turns and its own small error, and
 * is not what went wrong.
 */
function reported(c: Chain): Session {
  return c.find((s) => s.settled?.subtype === 'success') ?? c.find((s) => s.settled) ?? c[0]!;
}

/**
 * Which session each of one lap's records describes.
 *
 * By session id where the record carries one, which every session record has
 * since the first version. Position is not safe: a lap number is used again
 * once `unblock` or self-remediation drops its failed record, the transcript is
 * appended to, and the record that survives belongs to the LAST session in the
 * file, behind the ones nothing describes any more. A second record with the
 * same id is the conductor's own verdict on that session (a review that
 * finished and asked for changes) and is paired with nothing.
 *
 * Records without an id (a session cancelled before it reported one) take the
 * sessions nothing has claimed, newest first.
 */
export function pairRecords(records: PhaseRecord[], chains: Chain[]): Map<PhaseRecord, Chain> {
  const out = new Map<PhaseRecord, Chain>();
  const byId = new Map<string, Chain>();
  for (const c of chains) if (c[0]!.sessionId && !byId.has(c[0]!.sessionId)) byId.set(c[0]!.sessionId, c);
  const claimed = new Set<Chain>();
  const loose: PhaseRecord[] = [];
  for (const r of records) {
    if (!r.sessionId) { loose.push(r); continue; }
    const c = byId.get(r.sessionId);
    if (c && !claimed.has(c)) { out.set(r, c); claimed.add(c); }
  }
  const free = chains.filter((c) => !claimed.has(c));
  for (let i = 1; i <= Math.min(loose.length, free.length); i += 1) out.set(loose[loose.length - i]!, free[free.length - i]!);
  return out;
}

function quote(s: string): string { return `"${s}"`; }

function factsFor(
  records: PhaseRecord[], scanned: Scanned[], phases: PhaseSummary[], policy: Record<string, PhasePolicy>,
): Fact[] {
  const facts: Array<Omit<Fact, 'id'>> = [];
  const byFile = new Map(scanned.map((s) => [s.file, s]));

  // One journal record against the session it describes: see pairRecords.
  const fileOf = (r: PhaseRecord): string => `transcripts/${r.phase}-lap${r.lap}.jsonl`;
  const byRecFile = new Map<string, PhaseRecord[]>();
  for (const r of records) byRecFile.set(fileOf(r), [...(byRecFile.get(fileOf(r)) ?? []), r]);
  const told = new Map<PhaseRecord, Session>();
  const unrecorded: Array<Omit<Fact, 'id'>> = [];
  for (const [file, recs] of byRecFile) {
    const t = byFile.get(file);
    if (!t) continue;
    const chains = chainsOf(t.scan.sessions);
    const pairs = pairRecords(recs, chains);
    for (const [r, c] of pairs) told.set(r, reported(c));
    const taken = new Set(pairs.values());
    const left = chains.filter((c) => !taken.has(c));
    if (left.length) {
      const first = left.slice(0, 3).map((c) => {
        const x = reported(c);
        return `line ${c[0]!.line || 1} (${x.settled ? `ended \`${x.settled.subtype}\` after ${x.settled.turns} turns` : `no result frame, ${x.assistantFrames} assistant frame(s)`})`;
      }).join('; ');
      unrecorded.push({
        kind: 'unrecorded', phase: t.phase,
        text: `${file} holds ${chains.length} session(s) and the journal has ${recs.length} record(s) for that lap. No record describes the `
          + `session(s) at ${first}${left.length > 3 ? `, and ${left.length - 3} more` : ''}. A lap number is used again once \`unblock\` or `
          + 'self-remediation drops its failed record, and a conductor killed mid-session writes none: these sessions ran, and nothing in the '
          + 'journal says how they ended.',
        cites: left.slice(0, 3).map((c) => ({ file, line: c[0]!.line || 1 })),
      });
    }
  }

  for (const r of records) {
    const file = fileOf(r);
    const s = told.get(r);
    if (!s) continue;
    const where = `${r.phase} lap ${r.lap}`;
    const recorded = clipped(r.error ?? '', 200) || '(no error text)';
    const failed = r.status === 'failed' || r.status === 'infra' || r.status === 'warned' || r.status === 'skipped';

    if (!s.settled) {
      if (!failed) continue;
      const last = s.lastSaid;
      facts.push({
        kind: 'no-result', phase: r.phase,
        text: `${where} was recorded ${r.status}: ${quote(recorded)}. Its session has NO result frame: it was cut off after `
          + `${s.assistantFrames} assistant frame(s)` + (last ? `; the last thing it said was ${quote(last.text.slice(0, 200))}` : '') + '.',
        cites: [{ file, line: last?.line ?? s.line }],
      });
      continue;
    }

    const res = s.settled;
    if (res.subtype !== 'success') {
      const named = (r.error ?? '').includes(res.subtype);
      const cap = policy[r.phase]?.maxTurns;
      const kind: FactKind = res.subtype === 'error_max_turns' ? 'turn-cap'
        : res.subtype === 'error_max_structured_output_retries' ? 'structured-output'
          : 'masked-error';
      // A record that already names the session's own outcome hides nothing.
      if (named && kind === 'masked-error') continue;
      const extra = kind === 'turn-cap'
        ? ` after ${res.turns} turns${cap ? ` (the phase's cap in this checkout's config is ${cap})` : ''}`
        : kind === 'structured-output'
          ? ` after ${res.turns} turns of finished work; ${s.structuredRejects} of its ${s.structuredCalls} StructuredOutput call(s) were rejected by the schema`
          : '';
      facts.push({
        kind, phase: r.phase,
        text: `${where} was recorded ${r.status}: ${quote(recorded)}. `
          + `${named ? 'Its' : 'That is not what the session reported: its'} own result frame is \`${res.subtype}\`${extra}`
          + (res.text ? `: ${quote(res.text.slice(0, 220))}` : '') + '.',
        cites: [{ file, line: res.line }],
      });
      continue;
    }

    // The session finished. Anything the record says against that came from after it.
    if (failed && CRASH_TEXT_RE.test(r.error ?? '')) {
      const after = s.trailing[0];
      facts.push({
        kind: 'finished-then-exit', phase: r.phase,
        text: `${where} was recorded ${r.status}: ${quote(recorded)}. The session itself FINISHED: result \`success\`, `
          + `${res.turns} turns, structured output ${res.structured ? 'present' : 'absent'}. The error text describes the CLI `
          + 'process ending afterwards, not the work.'
          + (after ? ` A second result frame follows it: \`${after.subtype}\` ${quote(after.text.slice(0, 160))}.` : ''),
        cites: [{ file, line: res.line }, ...(after ? [{ file, line: after.line }] : [])],
      });
    } else if (r.status === 'ok' && CRASH_TEXT_RE.test(r.error ?? '')) {
      facts.push({
        kind: 'masked-error', phase: r.phase,
        text: `${where} was recorded ok and still carries the error text ${quote(recorded)}; its session's result frame is \`success\`.`,
        cites: [{ file, line: res.line }],
      });
    }
  }

  // Frames after the settled one, across the run: one fact, because it is one behaviour.
  const trailing = scanned.flatMap((t) => t.scan.sessions.flatMap((s) => s.trailing.map((f) => ({ file: t.file, f }))));
  if (trailing.length) {
    const texts = new Map<string, number>();
    for (const x of trailing) {
      const k = `${x.f.subtype}: ${x.f.text.split(/[;,]/)[0]!.slice(0, 100)}`;
      texts.set(k, (texts.get(k) ?? 0) + 1);
    }
    const top = [...texts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${quote(k)} ×${n}`).join(', ');
    facts.push({
      kind: 'trailing-frame', phase: '*',
      text: `${trailing.length} session(s) emitted a second result frame AFTER the one that settled them (${top}). `
        + 'phase.ts settles on the first; a record whose error text matches the second is describing the exit, not the session.',
      cites: trailing.slice(0, 5).map((x) => ({ file: x.file, line: x.f.line })),
    });
  }

  // MCP servers that connected and exposed nothing, or never connected.
  const sessions = scanned.flatMap((t) => t.scan.sessions.filter((s) => !s.resumed && s.line > 0).map((s) => ({ file: t.file, s })));
  const servers = new Set(sessions.flatMap((x) => x.s.mcp.map((m) => m.name)));
  for (const name of servers) {
    const withServer = sessions.filter((x) => x.s.mcp.some((m) => m.name === name));
    const empty = withServer.filter((x) => x.s.mcp.some((m) => m.name === name && m.status === 'connected' && m.tools === 0));
    const down = withServer.filter((x) => x.s.mcp.some((m) => m.name === name && m.status !== 'connected'));
    if (empty.length) {
      facts.push({
        kind: 'mcp-no-tools', phase: '*',
        text: `The \`${name}\` MCP server is reported \`connected\` and exposed 0 tools in ${empty.length} of ${withServer.length} `
          + `session(s): the init frame's tool list holds no \`mcp__${name}__*\` entry. Those sessions had no ${name} tools at all.`,
        cites: empty.slice(0, 5).map((x) => ({ file: x.file, line: x.s.line })),
      });
    }
    if (down.length) {
      facts.push({
        kind: 'mcp-not-connected', phase: '*',
        text: `The \`${name}\` MCP server was not connected in ${down.length} of ${withServer.length} session(s) `
          + `(status: ${[...new Set(down.flatMap((x) => x.s.mcp.filter((m) => m.name === name).map((m) => m.status)))].join(', ')}).`,
        cites: down.slice(0, 5).map((x) => ({ file: x.file, line: x.s.line })),
      });
    }
  }

  for (const t of scanned) {
    for (const s of t.scan.sessions) {
      if (s.compactions >= 2) {
        facts.push({
          kind: 'compacted', phase: t.phase,
          text: `${t.phase} lap ${t.lap}: the session's context was compacted ${s.compactions} times: it outgrew its window and `
            + 'worked on from summaries of its own earlier turns.',
          cites: [{ file: t.file, line: s.line || 1 }],
        });
      }
    }
  }

  facts.push(...unrecorded);

  for (const p of phases) {
    const code = policy[p.phase]?.kind === 'code';
    // Times the phase RAN. A `parked` record is a poll that found a person had
    // not acted yet, one every half hour for as long as a merge request waits.
    const ran = p.ran;
    if (ran >= (code ? CODE_REPEATS : SESSION_REPEATS)) {
      facts.push({
        kind: 'repeated', phase: p.phase,
        text: `\`${p.phase}\` ran ${ran} times (journal records: ${Object.entries(p.byStatus).map(([k, n]) => `${n} ${k}`).join(', ')})`
          + (p.policy ? `; its policy is: ${p.policy}` : '') + '.',
        cites: [{ file: 'run.json', line: 1 }],
      });
    }
  }

  return facts.map((f, i) => ({ id: `F${i + 1}`, ...f }));
}

// ----------------------------------------------------------------- lap by lap

/**
 * What each lap of a repeated phase returned, from its own result frame.
 *
 * The artifact on disk is the LAST lap's. Whether a check was converging is
 * only visible across laps: a review that re-grades a settled point or raises
 * new ones each time, a verify that fails the same single case six times. Both
 * happened on one run and neither was in any one lap's error.
 */
function lapOutputsOf(scanned: Scanned[]): LapOutputs[] {
  const by = new Map<string, LapOutputs>();
  for (const t of [...scanned].sort((a, b) => a.lap - b.lap)) {
    for (const s of t.scan.sessions) {
      if (!s.settled) continue;
      const entry = by.get(t.phase) ?? { phase: t.phase, laps: [] };
      entry.laps.push({ lap: t.lap, file: t.file, line: s.settled.line, subtype: s.settled.subtype, turns: s.settled.turns, output: s.settled.output });
      by.set(t.phase, entry);
    }
  }
  return [...by.values()].filter((p) => p.laps.length >= 2);
}

// -------------------------------------------------------------------- signals

function groupSignals(scanned: Scanned[]): { groups: SignalGroup[]; chatter: Set<string>; failures: number } {
  const all = scanned.flatMap((t) => t.scan.signals.map((s) => ({ file: t.file, s })));
  const failures = all.filter((x) => x.s.kind === 'tool-error');
  const chatter = chatterLines(failures.map((x) => x.s.text));
  const by = new Map<string, SignalGroup>();
  for (const { file, s } of all) {
    // Chatter is a property of command output, whether or not the command failed.
    const noise = s.kind === 'tool-error' || s.kind === 'output-error' ? chatter : NONE;
    const key = signalKey(s.text, noise);
    if (!key) continue;
    const id = `${s.kind}|${key}`;
    let g = by.get(id);
    if (!g) {
      g = {
        id: '', kind: s.kind, key, count: 0, files: [], tool: s.tool, call: s.call,
        text: meaningful(s.text, noise), cites: [],
      };
      by.set(id, g);
    }
    g.count += 1;
    const f = g.files.find((x) => x.file === file);
    if (f) f.count += 1;
    else g.files.push({ file, count: 1 });
    if (g.cites.length < 6) g.cites.push({ file, line: s.line });
  }
  const groups = [...by.values()]
    .sort((a, b) => (b.files.length - a.files.length) || (b.count - a.count))
    .slice(0, MAX_GROUPS);
  groups.forEach((g, i) => { g.id = `S${i + 1}`; });
  return { groups, chatter, failures: failures.length };
}

// ----------------------------------------------------------------- db and log

function eventSummary(events: DbEvent[]): EventSummary[] {
  const by = new Map<string, EventSummary>();
  const statuses = new Map<string, Map<string, number>>();
  for (const e of events) {
    const s = by.get(e.kind) ?? { kind: e.kind, count: 0, firstAt: e.ts, lastAt: e.ts, sample: '' };
    s.count += 1;
    s.firstAt = Math.min(s.firstAt, e.ts);
    s.lastAt = Math.max(s.lastAt, e.ts);
    if (!s.sample && e.detail) s.sample = clipped(e.detail, 200);
    by.set(e.kind, s);
    // `run_finished` is written for a park as much as for a block, so the split
    // by status is what says "this run was put back sixty times".
    const status = readJsonText(e.detail)?.status;
    if (typeof status === 'string') {
      const m = statuses.get(e.kind) ?? new Map<string, number>();
      m.set(status, (m.get(status) ?? 0) + 1);
      statuses.set(e.kind, m);
    }
  }
  for (const [kind, m] of statuses) {
    const s = by.get(kind)!;
    s.sample = `by status: ${[...m].map(([k, n]) => `${n} ${k}`).join(', ')}`;
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

function readJsonText(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const LOG_STAMP_RE = /^\S*\s*\d{2}:\d{2}:\d{2}\s+/;

function logSummary(log: EvidenceInputs['log'], iid: number): Evidence['log'] {
  if (!log) return { source: '', unavailable: 'not collected', groups: [], tail: [] };
  if ('unavailable' in log) return { source: '', unavailable: log.unavailable, groups: [], tail: [] };
  // `#917` must not take `#9174`'s lines.
  const tag = new RegExp(`#${iid}(?!\\d)`);
  const mine = log.lines.map((l) => redact(l.replace(/\x1b\[[0-9;]*m/g, ''))).filter((l) => tag.test(l) || /\b(warn|error)\b/.test(l));
  const by = new Map<string, { text: string; count: number }>();
  for (const l of mine) {
    if (!/\b(warn|error)\b/.test(l)) continue;
    const body = l.replace(LOG_STAMP_RE, '');
    const k = normaliseLine(body).slice(0, 200);
    const g = by.get(k) ?? { text: flat(body).slice(0, 260), count: 0 };
    g.count += 1;
    by.set(k, g);
  }
  return {
    source: log.source,
    groups: [...by.values()].sort((a, b) => b.count - a.count).slice(0, MAX_LOG_GROUPS),
    tail: mine.filter((l) => tag.test(l)).slice(-LOG_TAIL).map((l) => flat(l).slice(0, 260)),
  };
}

// ---------------------------------------------------------------------- build

function transcriptFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'transcripts')).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

/**
 * Build the digest for one run directory, or null when it holds no journal.
 *
 * Reads the directory and nothing else: no GitLab, no database of its own. The
 * rows and the log are handed in by the caller, so the same function runs on
 * the live directory and on a copy of one.
 */
export function buildEvidence(input: EvidenceInputs): Evidence | null {
  const j = input.journal ?? readJson<RunJournal>(join(input.dir, 'run.json'));
  if (!j || !Array.isArray(j.phases)) return null;
  const policy = input.policy ?? {};

  const records = j.phases.filter((r) => !isOwn(r.phase));
  const scanned: Scanned[] = [];
  for (const f of transcriptFiles(input.dir)) {
    const m = /^(.*)-lap(\d+)\.jsonl$/.exec(f);
    const phase = m?.[1] ?? f.replace(/\.jsonl$/, '');
    if (isOwn(phase)) continue;
    scanned.push({ file: `transcripts/${f}`, phase, lap: Number(m?.[2] ?? 0), scan: scanTranscript(join(input.dir, 'transcripts', f)) });
  }

  const attempts = foldAttempts(records, new Set(scanned.map((s) => s.file)));
  const phases = summarisePhases(records, policy);
  const facts = factsFor(records, scanned, phases, policy);
  const { groups, chatter, failures } = groupSignals(scanned);

  // Said once, as its own fact: a line that prefixes every failure is itself
  // something wrong with the machine, and it is in none of the groups above.
  if (chatter.size) {
    const worth = [...chatter].filter((l) => !EXIT_LINE_RE.test(l));
    if (worth.length) {
      facts.push({
        id: `F${facts.length + 1}`, kind: 'every-failure-says', phase: '*',
        text: `At least half of the run's ${failures} failed tool calls begin with the same line(s), left out of the groups below: `
          + worth.slice(0, 4).map(quote).join(', ') + '.',
        cites: [],
      });
    }
  }

  const recorded = new Set(records.map((r) => `transcripts/${r.phase}-lap${r.lap}.jsonl`));
  for (const t of scanned) {
    if (recorded.has(t.file)) continue;
    facts.push({
      id: `F${facts.length + 1}`, kind: 'unrecorded', phase: t.phase,
      text: `${t.file} has no journal record now: ${t.scan.sessions.length} session(s) ran, and either the run never recorded the `
        + 'lap or its record was dropped since (`unblock` and self-remediation both drop failed records).',
      cites: [{ file: t.file, line: 1 }],
    });
  }

  const artifacts = (() => {
    try {
      return readdirSync(input.dir)
        .filter((f) => f.endsWith('.json') && f !== 'run.json' && f !== 'diagnosis.json')
        .sort()
        .map((f) => artifactBrief(input.dir, f))
        .filter((a): a is ArtifactBrief => a !== null);
    } catch {
      return [];
    }
  })();

  return {
    generatedAt: input.now ?? Date.now(),
    run: {
      iid: j.iid, runId: j.runId, title: clipped(j.title ?? '', 200), url: j.url ?? '', status: j.status,
      stoppedPhase: j.stoppedPhase ?? '', createdAt: j.createdAt ?? 0, stoppedAt: j.stoppedAt ?? 0,
      reason: clipped(j.blockedWhy ?? '', REASON_CHARS),
      reviewMode: j.reviewMode === true, branch: j.branch ?? '', worktree: j.worktree ?? '', baseSha: j.baseSha ?? '',
      mrIid: j.mrIid ?? null, mrUrl: j.mrUrl ?? '',
      remediations: (j.remediations ?? []).map((r) => ({
        phase: r.phase, category: r.category, fixed: r.fixed, reason: clipped(r.reason, 300), changes: r.changes.map((c) => clipped(c, 200)),
      })),
      decisions: (j.verifyCaseDecisions ?? []).map((d) => `${d.caseId}: ${d.verdict}`),
    },
    totals: {
      records: records.length,
      transcripts: scanned.length,
      transcriptBytes: scanned.reduce((n, t) => n + t.scan.bytes, 0),
      sessions: scanned.reduce((n, t) => n + t.scan.sessions.length, 0),
      // From the per-phase sums, which count a session's time and tokens once however often it was recorded.
      weighted: phases.reduce((n, p) => n + p.weighted, 0),
      minutes: phases.reduce((n, p) => n + p.minutes, 0),
    },
    phases,
    attempts,
    facts,
    lapOutputs: lapOutputsOf(scanned),
    signals: groups,
    transcripts: scanned.map((t) => ({
      file: t.file, phase: t.phase, lap: t.lap, bytes: t.scan.bytes, lines: t.scan.lines,
      ...(t.scan.skipped ? { skipped: t.scan.skipped } : {}),
      sessions: t.scan.sessions.map((s) => ({
        line: s.line, model: s.model, resumed: s.resumed, tools: s.tools, mcp: s.mcp, assistantFrames: s.assistantFrames,
        settled: s.settled, trailing: s.trailing, compactions: s.compactions, lastSaid: s.lastSaid,
        structuredCalls: s.structuredCalls, structuredRejects: s.structuredRejects,
      })),
      lastErrors: t.scan.signals.filter((s) => s.kind !== 'stderr').slice(-3)
        .map((s: RawSignal) => ({ line: s.line, kind: s.kind, tool: s.tool, call: s.call, text: meaningful(s.text, chatter) })),
    })),
    artifacts,
    gates: gatesOf(j),
    events: eventSummary(input.db?.events ?? []),
    log: logSummary(input.log, j.iid),
  };
}

// --------------------------------------------------------------------- render

const hhmm = (ms: number): string => (ms ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '?');
const mb = (b: number): string => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const cite = (c: Cite): string => `${c.file}:${c.line}`;

/**
 * The digest as the session reads it. Bounded: sections are cut at their own
 * limits, so one noisy run cannot push the stop reason or the facts out of the
 * prompt. The full digest is on disk beside the run for whatever is cut here.
 */
export function renderEvidence(e: Evidence, o: { maxAttempts?: number; maxSignals?: number; maxRows?: number } = {}): string {
  const maxAttempts = o.maxAttempts ?? 90;
  const maxSignals = o.maxSignals ?? 20;
  // Facts, transcripts and artifacts: a run of a hundred failed laps has a hundred of each.
  const maxRows = o.maxRows ?? 60;
  const more = (n: number, what: string): string => `… ${n} more ${what} in diagnosis/evidence.json`;
  const out: string[] = [];

  out.push('## The run');
  out.push(`#${e.run.iid} ${e.run.title}`);
  out.push(`run ${e.run.runId} · status ${e.run.status} · stopped at \`${e.run.stoppedPhase || '?'}\` · `
    + `${hhmm(e.run.createdAt)} → ${hhmm(e.run.stoppedAt)} UTC · ${e.totals.records} phase records, ${e.totals.minutes} min of phase time, `
    + `${compact(e.totals.weighted)} weighted tokens · ${e.totals.transcripts} transcripts (${mb(e.totals.transcriptBytes)}, ${e.totals.sessions} sessions)`);
  if (e.run.branch) out.push(`branch ${e.run.branch}${e.run.mrIid ? ` · MR !${e.run.mrIid}` : ''}${e.run.worktree ? ` · worktree ${e.run.worktree}` : ''}`);
  out.push('', '### The stop reason, as the journal and the ticket hold it', e.run.reason || '(none recorded)');
  if (e.run.remediations.length) {
    out.push('', '### Self-remediation already ran');
    for (const r of e.run.remediations) {
      out.push(`- on \`${r.phase}\`: ${r.category}, ${r.fixed ? 'fixed' : 'not fixed'}${r.changes.length ? ` — changed: ${r.changes.join('; ')}` : ''}`);
    }
    out.push('Its full account is in `remediate.json` (fields `diagnosis`, `humanNeeded`). Start from it; do not re-derive it.');
  }

  out.push('', '## Phases', 'phase · records · by status · minutes · weighted · policy');
  for (const p of e.phases) {
    out.push(`- ${p.phase} · ${p.records}${p.ran !== p.records ? ` (ran ${p.ran}×)` : ''} · ${Object.entries(p.byStatus).map(([k, n]) => `${n} ${k}`).join(', ')} · ${p.minutes}m · ${compact(p.weighted)}${p.policy ? ` · ${p.policy}` : ''}`);
  }

  out.push('', '## Phase attempts, in order', 'id · phase lap · status · start–end UTC · turns · what the journal recorded · transcript');
  const shown = e.attempts.length > maxAttempts
    ? [...e.attempts.slice(0, Math.floor(maxAttempts / 3)), ...e.attempts.slice(-Math.ceil((maxAttempts * 2) / 3))]
    : e.attempts;
  let last = 0;
  for (const a of shown) {
    const n = Number(a.id.slice(1));
    if (last && n !== last + 1) out.push(`  … ${n - last - 1} row(s) not shown; they are in diagnosis/evidence.json …`);
    last = n;
    const lap = a.lapTo !== a.lap ? `${a.lap}–${a.lapTo} (×${a.times})` : String(a.lap);
    out.push(`${a.id} ${a.phase} ${lap} · ${a.status} · ${hhmm(a.startedAt)}–${hhmm(a.endedAt).slice(6)} · `
      + `${a.turns ?? '-'}t${a.recorded ? ` · recorded: ${quote(a.recorded.slice(0, 240))}` : ''}${a.transcript ? ` · ${a.transcript}` : ''}`);
  }

  out.push('', '## Facts found by comparing the journal with the transcripts',
    'Each is an observation, not a conclusion, and each names where to look.');
  if (!e.facts.length) out.push('(none)');
  for (const f of e.facts.slice(0, maxRows)) out.push(`${f.id} [${f.kind}] ${f.text}${f.cites.length ? ` — ${f.cites.map(cite).join(', ')}` : ''}`);
  if (e.facts.length > maxRows) out.push(more(e.facts.length - maxRows, 'fact(s)'));

  if (e.lapOutputs.length) {
    out.push('', '## What each lap of a repeated phase returned',
      'From each lap\'s own result frame; the artifact on disk is only the last lap\'s. Compare them: a check that '
      + 're-grades a settled point, raises new ones every lap, or fails the same case every lap is not converging.');
    for (const p of e.lapOutputs) {
      out.push(p.phase);
      for (const l of p.laps) {
        out.push(`  lap ${l.lap} · ${l.subtype} ${l.turns}t${l.output ? ` · ${l.output}` : ''} — ${l.file}:${l.line}`);
      }
    }
  }

  out.push('', '## Failures that recur across the run',
    'Failed tool calls, guard denials, schema rejections and CLI stderr, grouped by their first distinguishing line. '
    + 'One that spans many transcripts belongs to the machine or the harness, not to one session.');
  if (!e.signals.length) out.push('(none)');
  for (const g of e.signals.slice(0, maxSignals)) {
    out.push(`${g.id} ×${g.count} in ${g.files.length} transcript(s) [${g.kind}${g.tool ? ` ${g.tool}` : ''}] ${quote(g.text)}`
      + (g.call ? `\n    first call: ${g.call.slice(0, 160)}` : '')
      + `\n    at: ${g.cites.map(cite).join(', ')}`);
  }
  if (e.signals.length > maxSignals) out.push(`… ${e.signals.length - maxSignals} more group(s) in diagnosis/evidence.json`);

  out.push('', '## How each transcript ended', 'file · size · sessions · settled result of each · last failed call');
  for (const t of e.transcripts.slice(0, maxRows)) {
    if (t.skipped) { out.push(`- ${t.file} · ${mb(t.bytes)} · not read: ${t.skipped}`); continue; }
    const ends = t.sessions.map((s) => {
      const r = s.settled;
      const head = `${s.resumed ? 'resume' : 'session'}@${s.line}`;
      if (!r) return `${head}: no result frame (${s.assistantFrames} assistant frames)`;
      return `${head}: ${r.subtype} @${r.line} ${r.turns}t${s.trailing.length ? ` +${s.trailing.length} trailing` : ''}`;
    }).join('; ');
    const err = t.lastErrors[t.lastErrors.length - 1];
    out.push(`- ${t.file} · ${mb(t.bytes)} · ${ends}${err ? ` · last failure @${err.line}: ${quote(err.text.slice(0, 140))}` : ''}`);
  }
  if (e.transcripts.length > maxRows) out.push(more(e.transcripts.length - maxRows, 'transcript(s)'));

  out.push('', '## Artifacts in the run directory');
  for (const a of e.artifacts.slice(0, maxRows)) {
    const f = Object.entries(a.fields).map(([k, v]) => `${k}: ${v}`).join(' · ');
    out.push(`- ${a.file} (${mb(a.bytes)}, ${hhmm(a.modifiedAt)})${f ? ` — ${f}` : ''}`);
  }
  if (e.artifacts.length > maxRows) out.push(more(e.artifacts.length - maxRows, 'file(s)'));

  if (e.gates.length || e.run.decisions.length) {
    out.push('', '## Gates');
    for (const g of e.gates) {
      out.push(`- ${g.gate}: ${g.approved ? 'approved' : g.standing ? 'asked, not yet answered' : 'not approved'}, ${g.rounds} round(s) of feedback`);
    }
    if (e.run.decisions.length) out.push(`- QA decisions on failing verify cases: ${e.run.decisions.join(', ')}`);
  }

  if (e.events.length) {
    out.push('', '## Conductor events for this run (state/oneshot.db)', 'kind · count · first–last UTC · one sample');
    for (const ev of e.events.slice(0, 25)) {
      out.push(`- ${ev.kind} · ${ev.count} · ${hhmm(ev.firstAt)}–${hhmm(ev.lastAt).slice(6)}${ev.sample ? ` · ${ev.sample}` : ''}`);
    }
  }

  out.push('', '## Conductor log');
  if (e.log.unavailable) {
    out.push(`(not available: ${e.log.unavailable})`);
  } else {
    out.push(`source: ${e.log.source}`);
    for (const g of e.log.groups) out.push(`- ×${g.count} ${g.text}`);
    if (e.log.tail.length) out.push('last lines naming this ticket:', ...e.log.tail.map((l) => `  ${l}`));
  }

  return out.join('\n');
}
