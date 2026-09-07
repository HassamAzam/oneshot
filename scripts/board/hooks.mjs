import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Best-effort timing for tool calls, from Oneshot's hook event log.
 * SDK transcript lines carry no timestamps; state/hook-events.jsonl carries one per
 * PreToolUse/PostToolUse with the Claude session id and tool name (but no tool_use_id),
 * so the i-th call of tool T in the transcript is matched to the i-th Pre/Post pair of T.
 */
export function loadHookIndex(oneshotHome) {
  const f = join(oneshotHome, 'state', 'hook-events.jsonl');
  const idx = new Map();
  if (!existsSync(f)) return idx;
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch { return idx; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.kind !== 'PreToolUse' && d.kind !== 'PostToolUse') continue;
    const sid = d.detail?.session;
    const tool = d.detail?.tool;
    if (!sid || !tool || typeof d.ts !== 'number') continue;
    let arr = idx.get(sid);
    if (!arr) { arr = []; idx.set(sid, arr); }
    arr.push({ ts: d.ts, kind: d.kind, tool });
  }
  return idx;
}

export function timingFor(events, toolCallsInOrder) {
  const out = new Map();
  if (!events || !events.length) return out;
  const pre = new Map(), post = new Map();
  for (const e of events) {
    const m = e.kind === 'PreToolUse' ? pre : post;
    if (!m.has(e.tool)) m.set(e.tool, []);
    m.get(e.tool).push(e.ts);
  }
  const seen = new Map();
  for (const t of toolCallsInOrder) {
    const i = seen.get(t.tool_name) ?? 0;
    seen.set(t.tool_name, i + 1);
    const s = pre.get(t.tool_name)?.[i];
    const e = post.get(t.tool_name)?.[i];
    if (!s) continue;
    out.set(t.tool_use_id, {
      started_at: new Date(s).toISOString(),
      ended_at: e ? new Date(e).toISOString() : null,
      duration_ms: e ? Math.max(0, e - s) : null,
    });
  }
  return out;
}
