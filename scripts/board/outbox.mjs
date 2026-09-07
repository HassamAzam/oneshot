import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shipping order — parents before children, so a batch never references a row a later batch inserts. */
export const TABLES = ['operators', 'runs', 'sessions', 'agent_calls', 'skill_calls', 'tool_calls', 'transcript_lines'];
const PK = {
  operators: (r) => r.id,
  runs: (r) => r.run_id,
  sessions: (r) => r.session_id,
  agent_calls: (r) => r.tool_use_id,
  skill_calls: (r) => r.tool_use_id,
  tool_calls: (r) => r.tool_use_id,
  transcript_lines: (r) => `${r.session_id}:${r.line_no}`,
};

export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Durable, coalescing outbox. Keyed by primary key, so a newer snapshot of a session
 * replaces the older one while it waits — twenty minutes offline becomes one write.
 */
export class Outbox {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'outbox.json');
    this.v = 0;
    this.dirty = false;
    this.pending = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
    mkdirSync(dir, { recursive: true });
    this.load();
  }
  load() {
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const t of TABLES) for (const [k, row] of Object.entries(j[t] || {})) this.pending[t].set(k, { v: ++this.v, row });
    } catch (e) {
      console.error(`[outbox] unreadable ${this.file}: ${e.message} — starting empty`);
    }
  }
  /** Written only when something changed: a 40 MB backfill must not be rewritten every scan. */
  persist() {
    if (!this.dirty) return;
    const j = {};
    for (const t of TABLES) { j[t] = {}; for (const [k, e] of this.pending[t]) j[t][k] = e.row; }
    atomicWrite(this.file, JSON.stringify(j));
    this.dirty = false;
  }
  put(table, row) { this.pending[table].set(PK[table](row), { v: ++this.v, row }); this.dirty = true; }
  counts() { return Object.fromEntries(TABLES.map((t) => [t, this.pending[t].size])); }
  size() { return TABLES.reduce((a, t) => a + this.pending[t].size, 0); }

  /** Batches in FK order, each under maxBytes serialized. */
  batches(maxBytes) {
    const out = [];
    let cur = null;
    const open = () => { cur = { payload: {}, keys: [], bytes: 2 }; out.push(cur); };
    open();
    for (const t of TABLES) {
      for (const [k, e] of this.pending[t]) {
        const b = JSON.stringify(e.row).length + 2;
        if (cur.bytes + b > maxBytes && cur.keys.length) open();
        (cur.payload[t] ||= []).push(e.row);
        cur.keys.push([t, k, e.v]);
        cur.bytes += b;
      }
    }
    return out.filter((b) => b.keys.length);
  }
  /** Drop what was shipped — unless it changed again while the request was in flight. */
  ack(keys) {
    for (const [t, k, v] of keys) {
      const e = this.pending[t].get(k);
      if (e && e.v === v) { this.pending[t].delete(k); this.dirty = true; }
    }
  }
}
