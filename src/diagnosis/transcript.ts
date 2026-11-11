/**
 * A phase transcript, read for how its sessions ENDED and what went wrong on
 * the way, and never for what they said.
 *
 * src/lib/report.ts walks the same files to show a person every turn. This
 * reader exists because the failure diagnosis needs the opposite: a run leaves
 * tens of megabytes of transcript, and the handful of frames that explain a
 * stop are the result frames, the session starts, the tool calls that came back
 * as errors and the CLI's stderr. Everything here is positions and short
 * excerpts, so a whole run fits in one prompt and every excerpt can be cited as
 * `file:line` and checked afterwards.
 *
 * Three facts about the source shape what is kept.
 *
 * A FILE is not a session. A lap that dies of infrastructure is re-entered at
 * the same lap number and phase.ts appends to the same tee, so one file can
 * hold several `system:init` frames. Each one opens a session here.
 *
 * The FIRST result frame of a session is the one phase.ts settles on. The CLI
 * can emit another after it (`error_during_execution`, zero turns) when it
 * exits on a late background-task notice, and for a long time that trailing
 * frame's text, or the SDK's "process exited with code 1", was what the journal
 * recorded in place of the session's own outcome. So the two are kept apart:
 * `settled` is the session's account of itself, `trailing` is what came after.
 *
 * A frame is one LINE, and a line can be hundreds of kilobytes: a tool result
 * holding a whole file. Nothing here returns a frame whole. The peek helpers at
 * the bottom are what a diagnosis session uses instead of `cat`, `Read` or a
 * raw grep, each of which would put that line into its context.
 */
import { readFileSync, statSync } from 'node:fs';
import { redact } from '../lib/report.js';

/** A transcript past this size is described by its size alone. */
export const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const RESULT_CHARS = 600;
const SIGNAL_CHARS = 800;
const SAID_CHARS = 400;
const CALL_CHARS = 200;
/** Raw signals kept per file. Past it only the count grows. */
const MAX_SIGNALS = 600;
/** Failure lines kept per file from commands that did not fail. */
const MAX_OUTPUT_SIGNALS = 300;
/** How much of either end of a command's output is searched for a failure line. */
const OUTPUT_SCAN_CHARS = 20_000;

/**
 * A line of command output that reports a failure.
 *
 * Most of what goes wrong in a session never fails a tool call. A phase runs
 * `git fetch 2>&1 | tail`, or `app.cjs ensure; echo done`, and the command
 * exits 0 with the failure in its output: on ticket 9174 the port-drift error
 * appeared 44 times and five of those were failed calls. So Bash output is
 * searched too, for the handful of shapes a failure is written in.
 */
const FAILURE_LINE_RE = new RegExp([
  '(?:^|\\s)(?:fatal|FATAL|ERROR|Error|error):\\s',
  'Traceback \\(most recent call last\\)',
  '\\bE_[A-Z][A-Z_]{2,}\\b',
  '\\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|EACCES)\\b',
  'command not found',
  'Permission denied',
  '[Aa]uthentication failed',
  'could not read Username',
  'Connection refused',
  'Timeout \\d+ms exceeded',
  'ModuleNotFoundError',
  'Cannot find module',
  'OperationalError',
].join('|'));

export interface ResultFrame {
  line: number;
  subtype: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  /** The session's closing text on success, the errors it listed otherwise. */
  text: string;
  /** A schema-valid `structured_output` rode on the frame. */
  structured: boolean;
  /**
   * What that output said, in one line: its verdict fields, and each list of
   * ids it carried with their severity or result. '' when there was none. The
   * artifact file is overwritten by every later lap, so this is the only place
   * an earlier lap's answer survives.
   */
  output: string;
}

export interface McpServer { name: string; status: string; tools: number }

export interface Session {
  /** Line of the `system:init` frame that opened it; 0 when the file starts mid-session. */
  line: number;
  sessionId: string;
  model: string;
  /** An init whose session id was already seen: the resume phase.ts makes to recover structured output. */
  resumed: boolean;
  /** Tools the session started with, every kind. */
  tools: number;
  mcp: McpServer[];
  assistantFrames: number;
  settled: ResultFrame | null;
  trailing: ResultFrame[];
  /** Times the CLI compacted the context: the session outgrew its window. */
  compactions: number;
  lastSaid: { line: number; text: string } | null;
  structuredCalls: number;
  structuredRejects: number;
}

/**
 * `output-error` is a failure line in the output of a command that itself
 * succeeded; the rest are calls or processes that failed outright.
 */
export type SignalKind = 'tool-error' | 'guard-deny' | 'schema-reject' | 'stderr' | 'api-error' | 'output-error';

export interface RawSignal {
  line: number;
  kind: SignalKind;
  /** The tool whose call failed; '' for stderr and API errors. */
  tool: string;
  /** What was called: the command, path or pattern. */
  call: string;
  text: string;
}

export interface TranscriptScan {
  bytes: number;
  lines: number;
  /** Lines that are not JSON: a tee cut mid-write. */
  unparseable: number;
  /** Set when the file was not read at all. */
  skipped?: string;
  sessions: Session[];
  signals: RawSignal[];
  /** Signals seen beyond MAX_SIGNALS. */
  signalsDropped: number;
}

type Frame = Record<string, unknown>;

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

function cut(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? '';
  const text = flat(raw);
  return redact(text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text);
}

/**
 * Like cut(), with the line breaks kept. A failed command's output is lines,
 * and the digest needs them: it drops the lines that prefix every failure on a
 * machine (a shell's start-up complaint) to reach the one that names this one.
 */
function clip(value: unknown, limit: number): string {
  const raw = (typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? '').trim();
  return redact(raw.length > limit ? `${raw.slice(0, limit)}… (+${raw.length - limit} chars)` : raw);
}

/** tool_result content: a string on some tools, blocks on others. Images are named, never inlined. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b) => {
    const block = b as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    if (block.type === 'image') return '[image]';
    return JSON.stringify(block);
  }).join('\n');
}

/** Up to three distinct failure lines from one command's output, each with the line after it. */
export function failureLines(output: string): string[] {
  const text = output.length > OUTPUT_SCAN_CHARS * 2
    ? `${output.slice(0, OUTPUT_SCAN_CHARS)}\n${output.slice(-OUTPUT_SCAN_CHARS)}`
    : output;
  const lines = text.split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < 3; i += 1) {
    const l = lines[i]!.trim();
    if (!l || l.length > 600 || !FAILURE_LINE_RE.test(l)) continue;
    const key = l.replace(/\d+/g, 'N');
    if (seen.has(key)) continue;
    seen.add(key);
    // The line after it is usually the detail. Not when it is a failure line
    // in its own right: that one gets its own entry.
    const next = (lines[i + 1] ?? '').trim();
    out.push(next && next.length <= 300 && !FAILURE_LINE_RE.test(next) ? `${l}\n${next}` : l);
  }
  return out;
}

/** One line standing in for a tool's input: the path, command or pattern that identifies the call. */
function callOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const first = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? o.skill ?? o.description ?? o.prompt;
  return cut(typeof first === 'string' ? first : o, CALL_CHARS);
}

function parse(line: string): Frame | null {
  if (!line) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Frame) : null;
  } catch {
    return null;
  }
}

const OUTPUT_CHARS = 500;
const VERDICT_FIELDS = ['verdict', 'status', 'outcome', 'category', 'fixed'];
/** Tags that mean "nothing to see": an item carrying one is counted, not listed. */
const QUIET_TAGS = new Set(['pass', 'passed', 'ok', 'approved', 'done']);

/**
 * A phase's structured output as one line a reader can compare across laps:
 * `verdict=changes-requested · findings: 3 (1 blocker, 2 minor) · F-01:blocker F-02:minor`.
 *
 * Generic on purpose. Every handoff here is "some verdict fields, and lists of
 * things with an id and a grade" (findings with a severity, cases with a
 * result), so the same reading serves review, verify and whatever comes next
 * without knowing any of their schemas.
 */
export function outputBrief(output: unknown): string {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  const o = output as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of VERDICT_FIELDS) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') bits.push(`${k}=${String(v)}`);
  }
  if (typeof o.blocked === 'string' && o.blocked.trim()) bits.push(`blocked: ${flat(o.blocked).slice(0, 140)}`);
  for (const [k, v] of Object.entries(o)) {
    if (!Array.isArray(v)) continue;
    const items = v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).id === 'string');
    if (!items.length) continue;
    const tag = (x: Record<string, unknown>): string => String(x.severity ?? x.result ?? x.disposition ?? x.status ?? '');
    // A list with no grades (a case list, a plan's steps) is only a count.
    if (items.every((x) => !tag(x))) { bits.push(`${k}: ${items.length}`); continue; }
    const tally = new Map<string, number>();
    for (const x of items) tally.set(tag(x) || '?', (tally.get(tag(x) || '?') ?? 0) + 1);
    bits.push(`${k}: ${items.length} (${[...tally].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ')})`);
    const loud = items.filter((x) => !QUIET_TAGS.has(tag(x))).slice(0, 12).map((x) => `${String(x.id)}:${tag(x) || '?'}`);
    if (loud.length) bits.push(loud.join(' '));
  }
  return redact(bits.join(' · ').slice(0, OUTPUT_CHARS));
}

/**
 * A result frame as the peek commands print it, uncut: `[result success
 * turns=12] <its text>`. The citation check matches a quote against this, so a
 * quote copied from peek's output checks out label and all, and a label that
 * says something else about the frame does not.
 */
export function resultLine(frame: unknown): string | null {
  const f = frame as Frame | null;
  if (!f || typeof f !== 'object' || f.type !== 'result') return null;
  const errors = Array.isArray(f.errors) ? f.errors.map(String).join('; ') : '';
  const subtype = String(f.subtype ?? 'result');
  const text = subtype === 'success' ? String(f.result ?? '') : errors || String(f.result ?? '');
  return `[result ${subtype}${f.is_error === true ? ' is_error' : ''} turns=${Number(f.num_turns ?? 0)}] ${flat(text)}`;
}

function resultFrame(frame: Frame, line: number): ResultFrame {
  const errors = Array.isArray(frame.errors) ? frame.errors.map(String).join('; ') : '';
  const subtype = String(frame.subtype ?? 'result');
  return {
    line,
    subtype,
    isError: frame.is_error === true,
    turns: Number(frame.num_turns ?? 0),
    durationMs: Number(frame.duration_ms ?? 0),
    text: cut(subtype === 'success' ? frame.result ?? '' : errors || frame.result || '', RESULT_CHARS),
    structured: !!frame.structured_output && typeof frame.structured_output === 'object',
    output: outputBrief(frame.structured_output),
  };
}

function newSession(line: number, frame: Frame | null, seen: Set<string>): Session {
  const tools = Array.isArray(frame?.tools) ? frame.tools.map(String) : [];
  const servers = Array.isArray(frame?.mcp_servers) ? frame.mcp_servers as Array<Record<string, unknown>> : [];
  const sessionId = String(frame?.session_id ?? '');
  const resumed = !!sessionId && seen.has(sessionId);
  if (sessionId) seen.add(sessionId);
  return {
    line,
    sessionId,
    model: String(frame?.model ?? ''),
    resumed,
    tools: tools.length,
    mcp: servers.map((s) => {
      const name = String(s.name ?? '');
      return { name, status: String(s.status ?? ''), tools: tools.filter((t) => t.startsWith(`mcp__${name}__`)).length };
    }),
    assistantFrames: 0,
    settled: null,
    trailing: [],
    compactions: 0,
    lastSaid: null,
    structuredCalls: 0,
    structuredRejects: 0,
  };
}

/**
 * Read one transcript into sessions and signals.
 *
 * Never throws: a missing, unreadable or oversized file comes back as an empty
 * scan that says why, because a diagnosis that dies on its evidence explains
 * nothing.
 */
export function scanTranscript(path: string): TranscriptScan {
  const out: TranscriptScan = { bytes: 0, lines: 0, unparseable: 0, sessions: [], signals: [], signalsDropped: 0 };
  let text: string;
  try {
    const st = statSync(path);
    // A run directory is written by sessions. A pipe or a device named like a
    // transcript would hold the read, and the conductor with it, for ever.
    if (!st.isFile()) {
      out.skipped = 'not a regular file';
      return out;
    }
    out.bytes = st.size;
    if (out.bytes > MAX_SCAN_BYTES) {
      out.skipped = `larger than ${Math.round(MAX_SCAN_BYTES / (1024 * 1024))} MB`;
      return out;
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    out.skipped = `unreadable: ${(err as Error).message}`;
    return out;
  }

  const seenIds = new Set<string>();
  const calls = new Map<string, { tool: string; call: string }>();
  let current: Session | null = null;
  // A file that starts mid-session (no init frame) still gets one to hang its frames on.
  const session = (): Session => {
    if (!current) {
      current = newSession(0, null, seenIds);
      out.sessions.push(current);
    }
    return current;
  };
  let outputSignals = 0;
  const signal = (s: RawSignal): void => {
    const full = s.kind === 'output-error' ? outputSignals >= MAX_OUTPUT_SIGNALS : out.signals.length - outputSignals >= MAX_SIGNALS;
    if (full) { out.signalsDropped += 1; return; }
    if (s.kind === 'output-error') outputSignals += 1;
    out.signals.push(s);
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (!raw) continue;
    const line = i + 1;
    out.lines = line;
    const frame = parse(raw);
    if (!frame) { out.unparseable += 1; continue; }

    if (frame.type === 'cli-stderr') {
      const t = clip(frame.text, SIGNAL_CHARS);
      if (t) signal({ line, kind: 'stderr', tool: '', call: '', text: t });
      continue;
    }

    if (frame.type === 'system') {
      if (frame.subtype === 'init') {
        current = newSession(line, frame, seenIds);
        out.sessions.push(current);
      } else if (frame.subtype === 'compact_boundary') {
        session().compactions += 1;
      }
      continue;
    }

    if (frame.type === 'result') {
      const s = session();
      const r = resultFrame(frame, line);
      if (s.settled) s.trailing.push(r);
      else s.settled = r;
      continue;
    }

    const message = frame.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (frame.type === 'assistant') {
      const s = session();
      s.assistantFrames += 1;
      if (typeof frame.error === 'string' && frame.error) {
        signal({ line, kind: 'api-error', tool: '', call: '', text: clip(`${frame.error}: ${resultText(content)}`, SIGNAL_CHARS) });
      }
    }
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      const block = b as Record<string, unknown>;

      if (block.type === 'text' && frame.type === 'assistant') {
        const said = cut(block.text, SAID_CHARS);
        const s = session();
        // What it said before it settled is its last word on the work; text after
        // a result frame belongs to whatever came next.
        if (said && !s.settled) s.lastSaid = { line, text: said };
        continue;
      }

      if (block.type === 'tool_use') {
        const tool = String(block.name ?? 'tool');
        if (typeof block.id === 'string') calls.set(block.id, { tool, call: callOf(block.input) });
        if (tool === 'StructuredOutput') session().structuredCalls += 1;
        continue;
      }

      if (block.type === 'tool_result' && block.is_error === true) {
        const from = calls.get(String(block.tool_use_id ?? '')) ?? { tool: '', call: '' };
        const t = clip(resultText(block.content), SIGNAL_CHARS);
        let kind: SignalKind = 'tool-error';
        if (from.tool === 'StructuredOutput') {
          kind = 'schema-reject';
          session().structuredRejects += 1;
        } else if (GUARD_DENY_RE.test(t)) {
          kind = 'guard-deny';
        }
        signal({ line, kind, tool: from.tool, call: from.call, text: t });
        continue;
      }

      if (block.type === 'tool_result') {
        const from = calls.get(String(block.tool_use_id ?? ''));
        // Only a command's output, and only of a command that DID something: a
        // Read, a Grep or a `cat` of a source file returns source, and source is
        // full of the word "error". A background command's output comes back
        // through TaskOutput, which is where a dev server's failure is.
        if (!from || !COMMAND_TOOLS.has(from.tool) || (from.tool === 'Bash' && READ_ONLY_CMD_RE.test(from.call))) continue;
        for (const l of failureLines(resultText(block.content))) {
          signal({ line, kind: 'output-error', tool: from.tool, call: from.call, text: clip(l, SIGNAL_CHARS) });
        }
      }
    }
  }
  return out;
}

/** A guard's own reason text, and the CLI's wording when a hook refuses a call. */
const GUARD_DENY_RE = /^(?:Denied\b|Hook PreToolUse:\S+ denied)/;
const COMMAND_TOOLS = new Set(['Bash', 'TaskOutput', 'BashOutput']);
/** A command that only prints files: its output is their content, not the outcome of anything. */
const READ_ONLY_CMD_RE = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:cat|grep|egrep|rg|sed\s+-n|head|tail|less|awk|ls|find|wc|jq|git\s+(?:-C\s+\S+\s+)?(?:diff|show|log|grep|blame))\b/;

// ---------------------------------------------------------------------- peeks

export interface FrameLine { line: number; type: string; brief: string }

const BRIEF = 220;

function briefs(frame: Frame, calls: Map<string, string>, limit: number): string[] {
  if (frame.type === 'result') {
    const r = resultFrame(frame, 0);
    return [`[result ${r.subtype}${r.isError ? ' is_error' : ''} turns=${r.turns}] ${cut(r.text, limit)}`];
  }
  if (frame.type === 'system') {
    return frame.subtype === 'init' ? [`[session start ${String(frame.model ?? '')}]`] : [`[system ${String(frame.subtype ?? '')}]`];
  }
  if (frame.type === 'cli-stderr') return [`[stderr] ${cut(frame.text, limit)}`];
  const content = (frame.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === 'string') return [`${String(frame.type)}: ${cut(content, limit)}`];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    const block = b as Record<string, unknown>;
    if (block.type === 'text') {
      const t = cut(block.text, limit);
      if (t) out.push(`said: ${t}`);
    } else if (block.type === 'tool_use') {
      const name = String(block.name ?? 'tool');
      if (typeof block.id === 'string') calls.set(block.id, name);
      out.push(`call ${name}: ${cut(typeof block.input === 'object' ? callOf(block.input) : block.input, limit)}`);
    } else if (block.type === 'tool_result') {
      const name = calls.get(String(block.tool_use_id ?? '')) ?? '';
      out.push(`${block.is_error === true ? 'ERROR' : 'result'}${name ? ` (${name})` : ''}: ${cut(resultText(block.content), limit)}`);
    }
  }
  return out;
}

/** One short line per frame between `from` and `to` (inclusive, 1-based). */
export function listFrames(path: string, from = 1, to = Number.MAX_SAFE_INTEGER): FrameLine[] {
  const out: FrameLine[] = [];
  const calls = new Map<string, string>();
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const frame = parse(lines[i]!);
    if (!frame) continue;
    // Walk every frame so a result can name its tool, print only the window.
    const b = briefs(frame, calls, BRIEF);
    if (i + 1 < from || i + 1 > to) continue;
    out.push({ line: i + 1, type: String(frame.type ?? ''), brief: b.join(' | ') });
  }
  return out;
}

/** One frame, every block of it, each cut to `limit` characters. Null when the line is not a frame. */
export function frameAt(path: string, line: number, limit = 2000): string | null {
  const lines = readFileSync(path, 'utf8').split('\n');
  const calls = new Map<string, string>();
  // Tool names come from earlier frames, so the walk starts at the top.
  for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) {
    const f = parse(lines[i]!);
    if (f) briefs(f, calls, 0);
  }
  const frame = parse(lines[line - 1] ?? '');
  if (!frame) return null;
  return briefs(frame, calls, limit).join('\n');
}

export interface GrepHit { line: number; type: string; excerpt: string }

/** How much of a match itself is shown; the rest of a long one is cut like its surroundings. */
const GREP_MATCH_CHARS = 400;

/**
 * Search the DECODED text of every frame, and return the match with a little
 * around it. Decoded, because a raw JSONL line holds `\"` and `\n` where the
 * session saw quotes and newlines, so a pattern copied from an error message
 * misses the raw line it is sitting in.
 */
export function grepTranscript(path: string, pattern: RegExp, max = 40, around = 160): GrepHit[] {
  const hits: GrepHit[] = [];
  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length && hits.length < max; i += 1) {
    const frame = parse(lines[i]!);
    if (!frame) continue;
    // Flattened first: it is what this prints, so a pattern copied from its
    // output across what was a line break still finds the place.
    const text = flat(frameText(frame));
    const m = re.exec(text);
    if (!m) continue;
    // The window is bounded whatever matched (`[\s\S]+` matches the frame), and
    // its ends are moved out to a space so no token is cut in half: a credential
    // sliced through the middle is not one the redaction recognises.
    const snap = (at: number, step: -1 | 1): number => {
      let k = at;
      for (let n = 0; n < 80 && k > 0 && k < text.length && !/\s/.test(text[k + (step < 0 ? -1 : 0)]!); n += 1) k += step;
      return k;
    };
    const start = snap(Math.max(0, m.index - around), -1);
    const end = snap(Math.min(text.length, m.index + Math.min(m[0].length, GREP_MATCH_CHARS) + around), 1);
    hits.push({
      line: i + 1,
      type: String(frame.type ?? ''),
      excerpt: `${start > 0 ? '…' : ''}${redact(text.slice(start, end))}${end < text.length ? '…' : ''}`,
    });
  }
  return hits;
}

/** Every string a frame carries, joined: what a quotation from it is checked against. */
export function frameText(frame: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === 'string') { parts.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { parts.push(String(v)); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // Base64 image payloads are megabytes of nothing a quotation could match.
        if (k === 'data' && typeof x === 'string' && x.length > 4096) continue;
        walk(x, depth + 1);
      }
    }
  };
  walk(frame, 0);
  return parts.join('\n');
}

/** The decoded text of one line of a JSONL file, or null when that line is not JSON. */
export function lineText(path: string, line: number): string | null {
  const raw = readFileSync(path, 'utf8').split('\n')[line - 1];
  if (raw === undefined) return null;
  const frame = parse(raw);
  return frame ? frameText(frame) : null;
}
