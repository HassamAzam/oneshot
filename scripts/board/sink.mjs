/**
 * The board's Postgres, written directly — the collector and the board share a server.
 *
 * SPEC/ORDER/upsert are the board's old /api/ingest route, moved here unchanged except
 * for `evidence` and the two `interventions` attribution columns. `open()` trims every
 * spec to the columns the database actually has, so a collector newer than the board's
 * schema drops what the board cannot store instead of failing every batch.
 */
import pg from 'pg';

const SPEC = {
  operators: { pk: ['id'], cols: ['id', 'github_login', 'user_email', 'git_email', 'hostname', 'os_user', 'last_seen'], json: [] },
  runs: { pk: ['run_id'], cols: ['run_id', 'ticket_iid', 'title', 'url', 'status', 'branch', 'mr_iid', 'merged_sha', 'deployed_sha', 'blocked_why', 'operator_id', 'archived', 'started_at', 'ended_at'], json: [], touch: true },
  interventions: { pk: ['id'], cols: ['id', 'run_id', 'ticket_iid', 'gate', 'state', 'requested_at', 'feedback', 'rounds', 'operator_id', 'approved_by', 'feedback_by'], json: ['feedback', 'feedback_by'], touch: true },
  sessions: { pk: ['session_id'], cols: ['session_id', 'claude_session_id', 'run_id', 'ticket_iid', 'phase', 'lap', 'model', 'status', 'cwd', 'turns', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'weighted', 'started_at', 'ended_at', 'duration_ms', 'result_text', 'error_text', 'transcript_path', 'transcript_lines', 'last_activity_at', 'seq', 'operator_id'], json: [], guard: 'sessions.seq <= EXCLUDED.seq', guardCol: 'seq', touch: true },
  agent_calls: { pk: ['tool_use_id'], cols: ['tool_use_id', 'session_id', 'parent_tool_use_id', 'subagent_type', 'description', 'prompt', 'line_no', 'turns', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'tool_calls', 'status', 'result_text', 'started_at', 'ended_at', 'duration_ms'], json: [] },
  skill_calls: { pk: ['tool_use_id'], cols: ['tool_use_id', 'session_id', 'parent_tool_use_id', 'inside_agent', 'skill_name', 'args', 'line_no', 'ok', 'invoked_at'], json: [] },
  tool_calls: { pk: ['tool_use_id'], cols: ['tool_use_id', 'session_id', 'parent_tool_use_id', 'inside_agent', 'tool_name', 'input_summary', 'input', 'output_text', 'is_error', 'line_no', 'started_at', 'ended_at', 'duration_ms'], json: ['input'] },
  transcript_lines: { pk: ['session_id', 'line_no'], cols: ['session_id', 'line_no', 'kind', 'subtype', 'parent_tool_use_id', 'body'], json: ['body'] },
  evidence: { pk: ['id'], cols: ['id', 'run_id', 'ticket_iid', 'phase', 'lap', 'kind', 'tag', 'caption', 'source_path', 'path', 'bytes', 'width', 'height', 'duration_ms', 'operator_id'], json: [] },
};
export const TABLES = ['operators', 'runs', 'interventions', 'sessions', 'agent_calls', 'skill_calls', 'tool_calls', 'transcript_lines', 'evidence'];

/**
 * Postgres refuses U+0000 in both text and jsonb, and one refused row fails its whole
 * batch — which the flush loop then retries forever, so a single `head` of a binary
 * file in a transcript froze every row behind it. Swap it for U+FFFD, the same mark
 * the rest of that binary output already renders as.
 */
const noNul = (_k, v) => (typeof v === 'string' && v.includes('\u0000') ? v.replaceAll('\u0000', '�') : v);
export const serializeValue = (v) => (typeof v === 'string' ? noNul('', v) : v);
const jsonValue = (v) => JSON.stringify(v ?? null, noNul);

export class Sink {
  constructor(databaseUrl) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    // An idle client dropped by a Postgres restart emits 'error' on the pool; unhandled,
    // that kills the daemon. The next write reconnects, and its failure is what gets logged.
    this.pool.on('error', () => undefined);
    this.spec = null;
    this.dropped = {};
    this.missing = [];
  }

  /** Read the live schema once and keep, per table, only the spec columns it has. */
  async open() {
    const { rows } = await this.pool.query(
      "select table_name, column_name from information_schema.columns where table_schema = current_schema() and table_name = any($1)",
      [TABLES]);
    const have = {};
    for (const r of rows) (have[r.table_name] ??= new Set()).add(r.column_name);
    this.spec = {};
    this.dropped = {};
    for (const t of TABLES) {
      const s = SPEC[t];
      const cols = have[t] ?? new Set();
      const missing = s.cols.filter((c) => !cols.has(c));
      if (missing.length) this.dropped[t] = missing;
      // A table missing a key column cannot be upserted at all; its rows are dropped.
      if (s.pk.some((c) => !cols.has(c))) continue;
      this.spec[t] = {
        ...s,
        cols: s.cols.filter((c) => cols.has(c)),
        json: s.json.filter((c) => cols.has(c)),
        // A guard naming a column the board lacks would fail every flush with 42703.
        guard: s.guard && cols.has(s.guardCol) ? s.guard : null,
        touch: s.touch && cols.has('updated_at'),
      };
    }
    this.missing = TABLES.filter((t) => !this.spec[t]);
  }

  /** Spec columns the database lacks, per table — what this collector writes but the board drops. */
  droppedColumns() { return this.dropped; }

  /**
   * Upsert one outbox batch in one transaction. Returns rows written per table and the
   * tables it could not write (absent, or missing a key column) — the caller keeps those
   * rows queued. While any table is missing the schema is re-read on every write, so the
   * queued rows ship as soon as the board migrates.
   */
  async write(payload) {
    if (!this.spec || this.missing.length) await this.open();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const counts = {};
      for (const t of TABLES) counts[t] = await this.upsert(client, t, payload[t]);
      await client.query('COMMIT');
      return { counts, skipped: this.missing.filter((t) => payload[t]?.length) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Class 42 (a column or table gone under us): forget the schema so the retry re-reads it.
      if (String(e.code ?? '').startsWith('42')) this.spec = null;
      throw e;
    } finally {
      client.release();
    }
  }

  async upsert(client, table, rows) {
    const spec = this.spec[table];
    if (!rows?.length || !spec) return 0;
    const chunkSize = Math.max(1, Math.floor(30_000 / spec.cols.length));
    const updates = spec.cols.filter((c) => !spec.pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
    if (spec.touch) updates.push('updated_at = now()');
    // A table that is all key has nothing to update; leave the existing row as it is.
    const onConflict = updates.length
      ? `DO UPDATE SET ${updates.join(', ')}${spec.guard ? ` WHERE ${spec.guard}` : ''}`
      : 'DO NOTHING';
    let n = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const params = [];
      const tuples = [];
      for (const r of rows.slice(i, i + chunkSize)) {
        const ph = [];
        for (const c of spec.cols) {
          const isJson = spec.json.includes(c);
          params.push(isJson ? jsonValue(r[c]) : serializeValue(r[c] ?? null));
          ph.push(`$${params.length}${isJson ? '::jsonb' : ''}`);
        }
        tuples.push(`(${ph.join(',')})`);
      }
      const sql = `INSERT INTO ${table} (${spec.cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (${spec.pk.join(',')}) ${onConflict}`;
      const res = await client.query(sql, params);
      n += res.rowCount ?? 0;
    }
    return n;
  }

  async close() { await this.pool.end(); }
}
