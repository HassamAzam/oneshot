import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { CFG } from './config.mjs';
import { phaseRecord, sessionKey, ts } from './journal.mjs';
import { timingFor } from './hooks.mjs';

const cap = (s, n) => (s == null ? null : s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

function resultText(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b
      : b?.type === 'text' ? b.text
      : b?.type === 'image' ? '[image]'
      : JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(content);
}

function summarize(name, input) {
  const s = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (!input || typeof input !== 'object') return null;
  switch (name) {
    case 'Bash': return s(input.description ? `${input.description} — ${input.command}` : input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return s(input.file_path ?? input.notebook_path);
    case 'Grep': case 'Glob': return s(`${input.pattern}${input.path ? `  in ${input.path}` : ''}`);
    case 'Task': return s(`${input.subagent_type ?? 'agent'} — ${input.description ?? ''}`);
    case 'Skill': return s(input.skill ?? input.command);
    case 'WebFetch': return s(input.url);
    case 'WebSearch': return s(input.query);
    case 'TodoWrite': return s(`${(input.todos || []).length} todos`);
    case 'StructuredOutput': return s(Object.keys(input).join(', '));
    default: {
      const k = Object.keys(input)[0];
      return k ? s(`${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`) : null;
    }
  }
}

/** <phase>-lap<n>.jsonl */
export function parseTranscriptName(file) {
  const m = basename(file).match(/^(.+)-lap(\d+)\.jsonl$/);
  return m ? { phase: m[1], lap: Number(m[2]) } : null;
}

/**
 * Turn one transcript into a session snapshot plus its children.
 * The whole file is re-parsed each time it grows (fast, and far simpler than an incremental
 * state machine); only rows new since `sinceLine` are emitted for the append-only tables.
 */
export function extractTranscript({ file, journal, iid, operatorId, sinceLine, hookIndex, runStatus }) {
  const named = parseTranscriptName(file);
  if (!named) return null;
  const { phase, lap } = named;
  const st = statSync(file);
  const rawLines = readFileSync(file, 'utf8').split('\n');
  const rec = journal ? phaseRecord(journal, phase, lap) : null;
  const runId = journal?.runId ?? `iid-${iid}`;
  const sid = sessionKey(runId, phase, lap);
  const born = st.birthtimeMs > 0 ? st.birthtime : st.mtime;

  const session = {
    session_id: sid, claude_session_id: rec?.sessionId ?? null, run_id: runId, ticket_iid: iid, phase, lap,
    model: rec?.model ?? null, status: 'running', cwd: null, turns: 0,
    tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, weighted: rec?.weighted ?? null,
    started_at: ts(rec?.startedAt) ?? born.toISOString(), ended_at: null, duration_ms: null,
    result_text: null, error_text: rec?.error ? String(rec.error).slice(0, 4000) : null,
    transcript_path: file, transcript_lines: 0, seq: st.size, operator_id: operatorId,
    last_activity_at: null,
  };

  const agents = new Map();
  const skills = [];
  const tools = [];
  const toolById = new Map();
  const lines = [];
  const mainMsgs = new Map();
  const agentMsgs = new Map();
  let lineNo = 0;
  let sawResult = false;
  let resultOk = false;

  // Streaming can emit one assistant message several times (one per content block), each
  // carrying the same usage — count each API message id once, taking the max of every field.
  const mergeUsage = (map, id, u) => {
    const cur = map.get(id) || { input: 0, output: 0, cr: 0, cw: 0 };
    map.set(id, {
      input: Math.max(cur.input, u.input_tokens || 0),
      output: Math.max(cur.output, u.output_tokens || 0),
      cr: Math.max(cur.cr, u.cache_read_input_tokens || 0),
      cw: Math.max(cur.cw, u.cache_creation_input_tokens || 0),
    });
  };

  for (const raw of rawLines) {
    if (!raw) continue;
    lineNo += 1;
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    const type = d.type;
    const parent = d.parent_tool_use_id ?? null;

    if (lineNo > sinceLine) {
      const body = raw.length > CFG.maxLineBytes
        ? { type, subtype: d.subtype, _truncated: true, _bytes: raw.length, _preview: raw.slice(0, 4000) }
        : d;
      lines.push({ session_id: sid, line_no: lineNo, kind: type ?? null, subtype: d.subtype ?? null, parent_tool_use_id: parent, body });
    }

    if (type === 'system' && d.subtype === 'init') {
      session.claude_session_id = d.session_id ?? session.claude_session_id;
      session.cwd = d.cwd ?? null;
      session.model = d.model ?? session.model;
      continue;
    }
    if (type === 'result') {
      sawResult = true;
      resultOk = d.subtype === 'success' && !d.is_error;
      session.duration_ms = d.duration_ms ?? null;
      if (Number.isInteger(d.num_turns) && d.num_turns > 0) session.turns = d.num_turns;
      session.result_text = cap(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? null), 20_000);
      if (d.is_error && !session.error_text) session.error_text = cap(String(d.result ?? d.subtype ?? 'error'), 4000);
      continue;
    }
    const msg = d.message;
    if (!msg) continue;

    if (type === 'assistant') {
      const inAgent = parent && agents.has(parent) ? agents.get(parent) : null;
      if (msg.usage && msg.id) {
        if (inAgent) {
          if (!agentMsgs.has(parent)) agentMsgs.set(parent, new Map());
          mergeUsage(agentMsgs.get(parent), msg.id, msg.usage);
        } else mergeUsage(mainMsgs, msg.id, msg.usage);
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const input = b.input ?? {};
        const row = {
          tool_use_id: b.id, session_id: sid, parent_tool_use_id: parent, inside_agent: inAgent?.subagent_type ?? null,
          tool_name: b.name, input_summary: summarize(b.name, input), input, output_text: null, is_error: false,
          line_no: lineNo, started_at: null, ended_at: null, duration_ms: null, _resultLine: null,
        };
        tools.push(row);
        toolById.set(b.id, row);
        if (inAgent) inAgent.tool_calls += 1;
        if (b.name === 'Task') {
          agents.set(b.id, {
            tool_use_id: b.id, session_id: sid, parent_tool_use_id: parent,
            subagent_type: input.subagent_type ?? 'unknown', description: input.description ?? null,
            prompt: cap(String(input.prompt ?? ''), 20_000), line_no: lineNo,
            turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, tool_calls: 0,
            status: 'running', result_text: null, started_at: null, ended_at: null, duration_ms: null, _resultLine: null,
          });
        }
        if (b.name === 'Skill') {
          skills.push({
            tool_use_id: b.id, session_id: sid, parent_tool_use_id: parent, inside_agent: inAgent?.subagent_type ?? null,
            skill_name: input.skill ?? input.command ?? 'unknown', args: input.args ? String(input.args).slice(0, 2000) : null,
            line_no: lineNo, ok: null, invoked_at: null, _resultLine: null,
          });
        }
      }
    } else if (type === 'user') {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
        const out = resultText(b.content);
        const t = toolById.get(b.tool_use_id);
        if (t) { t.output_text = cap(out, CFG.maxToolOutputBytes); t.is_error = !!b.is_error; t._resultLine = lineNo; }
        const a = agents.get(b.tool_use_id);
        if (a) { a.status = b.is_error ? 'error' : 'ok'; a.result_text = cap(out, 20_000); a._resultLine = lineNo; }
        const sk = skills.find((s) => s.tool_use_id === b.tool_use_id);
        if (sk) { sk.ok = !b.is_error; sk._resultLine = lineNo; }
      }
    }
  }
  session.transcript_lines = lineNo;

  const sum = (map) => {
    const o = { input: 0, output: 0, cr: 0, cw: 0, n: 0 };
    for (const u of map.values()) { o.input += u.input; o.output += u.output; o.cr += u.cr; o.cw += u.cw; o.n += 1; }
    return o;
  };
  const m = sum(mainMsgs);
  session.tokens_in = m.input; session.tokens_out = m.output; session.cache_read = m.cr; session.cache_write = m.cw;
  if (!session.turns) session.turns = m.n;
  for (const [id, a] of agents) {
    const u = sum(agentMsgs.get(id) || new Map());
    a.turns = u.n; a.tokens_in = u.input; a.tokens_out = u.output; a.cache_read = u.cr; a.cache_write = u.cw;
  }

  // Status, in order of authority:
  //   a `result` line  — the session itself said it finished
  //   the journal      — the conductor recorded an outcome for this phase
  //   the run's status — a finished run cannot have a live phase
  //   silence          — the weakest signal, and only ever a hint
  //
  // Transcript silence is NOT death. A phase waiting on a long Bash, a test suite or
  // a Playwright run writes nothing for many minutes and is perfectly alive; an
  // `implement` phase was marked abandoned here while its `claude` process was still
  // running. So while the run is going and the journal has recorded no end for this
  // phase, the session stays live — 'stalled' once it has been quiet long enough to
  // be worth a look, which is a report, not a verdict.
  const journalStatus = rec?.status ?? null;
  const journalEnded = rec?.endedAt ? ts(rec.endedAt) : null;
  const runFinished = ['done', 'blocked', 'aborted'].includes(runStatus ?? journal?.status ?? '');
  const staleMs = Date.now() - st.mtimeMs;
  session.last_activity_at = st.mtime.toISOString();
  if (sawResult) {
    session.status = journalStatus ?? (resultOk ? 'ok' : 'failed');
    session.ended_at = journalEnded ?? st.mtime.toISOString();
  } else if (journalEnded) {
    session.status = journalStatus && journalStatus !== 'ok' ? journalStatus : 'abandoned';
    session.ended_at = journalEnded;
  } else if (runFinished) {
    // The run is over and this phase never returned a verdict — that one really is dead.
    session.status = 'abandoned';
    session.ended_at = st.mtime.toISOString();
  } else {
    session.status = staleMs > CFG.stalledAfterMs ? 'stalled' : 'running';
  }
  if (!session.duration_ms && session.started_at && session.ended_at) {
    session.duration_ms = Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at));
  }
  const sessionLive = session.status === 'running' || session.status === 'stalled';
  for (const a of agents.values()) if (a.status === 'running' && !sessionLive) a.status = 'abandoned';

  const timing = timingFor(session.claude_session_id ? hookIndex?.get(session.claude_session_id) : null, tools);
  for (const t of tools) { const x = timing.get(t.tool_use_id); if (x) Object.assign(t, x); }
  for (const a of agents.values()) { const x = timing.get(a.tool_use_id); if (x) Object.assign(a, x); }
  for (const s of skills) { const x = timing.get(s.tool_use_id); if (x) s.invoked_at = x.started_at; }

  const fresh = (r) => r.line_no > sinceLine || (r._resultLine != null && r._resultLine > sinceLine);
  const strip = (r) => { const { _resultLine, ...rest } = r; return rest; };
  return {
    session,
    agents: [...agents.values()].map(strip),
    skills: skills.filter(fresh).map(strip),
    tools: tools.filter(fresh).map(strip),
    lines,
    lineCount: lineNo,
    size: st.size,
  };
}
