/**
 * Small run directories for the diagnosis tests, built in a temp dir.
 *
 * A real run directory is tens of megabytes and quotes a private ticket, so
 * none is committed. These builders write the same SHAPES instead: the journal
 * fields and the SDK frames the diagnosis reads, each as small as the behaviour
 * under test allows. The shapes were taken from a real run's transcripts
 * (frame keys, result subtypes, the init frame's tool list), and a builder that
 * drifts from them would test nothing.
 *
 * Imports nothing from config, so a test can still set its environment first.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Frame = Record<string, unknown>;

let seq = 0;
const id = (p: string): string => `${p}_${(seq += 1)}`;

export const init = (o: { session?: string; tools?: string[]; mcp?: Array<{ name: string; status: string }> } = {}): Frame => ({
  type: 'system', subtype: 'init', session_id: o.session ?? id('sess'), model: 'claude-sonnet-5',
  tools: o.tools ?? ['Bash', 'Read', 'Grep', 'StructuredOutput', 'mcp__gitlab__get_issue'],
  mcp_servers: o.mcp ?? [{ name: 'gitlab', status: 'connected' }],
});

export const say = (text: string): Frame => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

/** A tool call and its result, as the two frames the SDK emits. */
export function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Frame[] {
  const tid = id('toolu');
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: tid, name: tool, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tid, content: output, ...(isError ? { is_error: true } : {}) }] } },
  ];
}

export const bash = (command: string, output: string, isError = false): Frame[] => call('Bash', { command }, output, isError);

export const success = (turns: number, o: { structured?: Record<string, unknown> | null; result?: string } = {}): Frame => ({
  type: 'result', subtype: 'success', is_error: false, num_turns: turns, duration_ms: turns * 1000,
  result: o.result ?? 'Done.',
  ...(o.structured === null ? {} : { structured_output: o.structured ?? { summary: 'done' } }),
});

export const failure = (subtype: string, turns: number, errors: string[] = []): Frame => ({
  type: 'result', subtype, is_error: subtype === 'error_during_execution', num_turns: turns, duration_ms: turns * 1000, errors,
});

/** The frame the CLI emits when it exits on a late background-task notice, after a session has already settled. */
export const lateExit = (): Frame => failure('error_during_execution', 0, ['only prompt commands are supported in streaming mode']);

export const stderr = (text: string): Frame => ({ type: 'cli-stderr', text });

export interface RecordSpec {
  phase: string; lap?: number; status?: string; error?: string; turns?: number; weighted?: number;
  startedAt?: number; endedAt?: number;
  /** As the conductor journals it, from the session's init frame. Leave it out for a record that never had one. */
  sessionId?: string;
}

export interface RunSpec {
  iid?: number;
  runId?: string;
  status?: string;
  blockedWhy?: string;
  stoppedPhase?: string;
  stoppedAt?: number;
  blockedAt?: number;
  project?: string;
  records?: RecordSpec[];
  /** Transcript file name (without directory) to its frames. A string is written as given, for cut-off lines. */
  transcripts?: Record<string, Array<Frame | string>>;
  /** Other files of the run directory, by name. */
  files?: Record<string, unknown>;
  journal?: Record<string, unknown>;
}

const T0 = Date.UTC(2026, 10, 10, 7, 45);

export function journalOf(spec: RunSpec): Record<string, unknown> {
  const iid = spec.iid ?? 990174;
  let t = T0;
  const phases = (spec.records ?? []).map((r) => {
    const startedAt = r.startedAt ?? t;
    const endedAt = r.endedAt ?? startedAt + 60_000;
    t = endedAt + 1000;
    return {
      phase: r.phase, lap: r.lap ?? 0, status: r.status ?? 'ok', startedAt, endedAt,
      ...(r.turns !== undefined ? { turns: r.turns } : {}),
      ...(r.weighted !== undefined ? { weighted: r.weighted } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    };
  });
  return {
    runId: spec.runId ?? 'r-test0001-abcdef', iid,
    project: spec.project ?? 'gitlab.example.com/acme/erp',
    title: 'Show the total on the invoice list', url: `https://gitlab.example.com/acme/erp/-/issues/${iid}`,
    createdAt: T0, status: spec.status ?? 'blocked',
    ...(spec.blockedWhy !== undefined ? { blockedWhy: spec.blockedWhy } : {}),
    ...(spec.stoppedPhase !== undefined ? { stoppedPhase: spec.stoppedPhase } : {}),
    stoppedAt: spec.stoppedAt ?? t,
    ...(spec.blockedAt !== undefined ? { blockedAt: spec.blockedAt } : {}),
    phases,
    ...spec.journal,
  };
}

/** Write a run directory and return its path with a cleanup. */
export function makeRun(spec: RunSpec = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-diag-'));
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(journalOf(spec), null, 2)}\n`);
  for (const [name, frames] of Object.entries(spec.transcripts ?? {})) {
    writeFileSync(join(dir, 'transcripts', name), `${frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n')}\n`);
  }
  for (const [name, data] of Object.entries(spec.files ?? {})) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Rewrite the journal of a run directory made by makeRun. */
export function rewriteJournal(dir: string, spec: RunSpec): void {
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(journalOf(spec), null, 2)}\n`);
}
