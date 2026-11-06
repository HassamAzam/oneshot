/**
 * `/run/:iid/tail` — what the newest phase session is doing, as one-liners.
 *
 * A transcript line is a whole SDK message, often kilobytes of JSON; the
 * question here is only "what did it last say, call and get back". Every line
 * goes through the report's redact(), because tool results quote environment,
 * logs and pages verbatim.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../../src/lib/config.js';
import { redact } from '../../src/lib/report.js';

const LINES = 80;
const BRIEF = 200;
// A transcript can reach many megabytes; the tail only needs its end.
const READ_BYTES = 2 * 1024 * 1024;

const brief = (s: unknown): string => {
  const flat = (typeof s === 'string' ? s : JSON.stringify(s) ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > BRIEF ? `${flat.slice(0, BRIEF)}…` : flat;
};

interface Block { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }

function summarise(line: string): string[] {
  let msg: { type?: string; subtype?: string; message?: { content?: unknown }; num_turns?: number; result?: unknown };
  try { msg = JSON.parse(line); } catch { return []; }
  if (msg.type === 'result') return [`[result] ${msg.subtype ?? ''} after ${msg.num_turns ?? '?'} turns ${brief(msg.result ?? '')}`];
  if (msg.type === 'system') return msg.subtype === 'init' ? ['[session start]'] : [];
  const content = msg.message?.content;
  if (typeof content === 'string') return [`${msg.type}: ${brief(content)}`];
  if (!Array.isArray(content)) return [];
  return (content as Block[]).flatMap((b): string[] => {
    if (b.type === 'text' && b.text?.trim()) return [`said: ${brief(b.text)}`];
    if (b.type === 'tool_use') return [`call ${b.name}: ${brief(b.input)}`];
    if (b.type === 'tool_result') return [`${b.is_error ? 'error' : 'result'}: ${brief(b.content)}`];
    return [];
  });
}

function newestTranscript(iid: number): string | null {
  const dir = join(runDir(iid), 'transcripts');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? join(dir, files[0].f) : null;
}

function readEnd(file: string): string {
  const size = statSync(file).size;
  const len = Math.min(size, READ_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

export function tail(iid: number): { file: string | null; lines: string[] } {
  const file = newestTranscript(iid);
  if (!file) return { file: null, lines: [] };
  const lines = readEnd(file).split('\n').flatMap(summarise).slice(-LINES).map(redact);
  return { file: file.split('/').pop() ?? null, lines };
}
