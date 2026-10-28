/**
 * Export a run to Langfuse from the CONDUCTOR, over OTLP, directly.
 *
 * The original design asked the Claude Code CLI to do this: set the OTEL_*
 * variables in a phase's environment and let the CLI emit its own spans. It was
 * a good idea and it does not work. A session spawned through the Agent SDK's
 * query() exports nothing at all — no trace, no span, no generation — while the
 * identical environment spawned as `claude -p` exports every time. Measured
 * three ways, including with the span-flush interval dropped to 200ms in case
 * the SDK was killing the child before its buffer drained. It is not a flush
 * race; the SDK path simply never initialises the CLI's OTLP pipeline. An
 * eighteen-phase run produced zero traces while the config, the credentials and
 * the endpoint were all provably correct.
 *
 * So the exporter moves to the one component that was never in doubt. The
 * conductor already knows everything a trace needs — which phases ran, on which
 * model, for how many turns, how long, what they spent and whether they
 * succeeded — because it is what scheduled them. It writes that itself now, and
 * the CLI's own telemetry becomes a bonus rather than the mechanism.
 *
 * What is lost by not being inside the session: per-tool-call and per-subagent
 * spans. What is kept: the run, every phase, timings, models, token spend and
 * outcomes — the shape people actually open Langfuse to see — plus, while
 * config/otel.json's logAssistantResponses is on, each lap's final result text
 * as its Output. Prompts are never sent. The full per-turn record is on disk, in
 * state/runs/<iid>/transcripts/.
 *
 * Ids are DERIVED rather than random, so re-exporting a run updates its spans
 * instead of duplicating them. That is what lets this be called after every
 * phase and again at the end without any bookkeeping.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transcriptPath } from './artifacts.js';
import { db } from './db.js';
import { envOr } from './config.js';
import { otelConfig } from './otel.js';
import { log } from './log.js';
import type { PhaseRecord, RunJournal } from './artifacts.js';

/** The parts of a run journal its trace is built from. */
export type ExportedRun = Pick<
  RunJournal,
  'runId' | 'iid' | 'title' | 'status' | 'createdAt' | 'phases' | 'branch' | 'mrIid' | 'mergedSha' | 'blockedWhy'
>;

/** One usage-ledger row: what one session spent, and when it was recorded. */
export interface UsageRow {
  ts: number;
  phase: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type Tokens = Omit<UsageRow, 'ts' | 'phase'>;

/** Characters of a lap's final text sent to Langfuse. The longest seen is under 4k. */
export const OUTPUT_CAP = 10_000;

/**
 * The final text a phase session wrote: `result` on the first result frame of
 * its transcript. Later frames are ignored, as phase.ts ignores them. Undefined
 * when the transcript is missing or the session never reached a result.
 */
export function finalResultText(transcript: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(transcript, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const msg = JSON.parse(line) as { type?: string; result?: unknown };
      if (msg.type === 'result') return typeof msg.result === 'string' ? msg.result : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** OTLP wants 16 bytes of trace id and 8 of span id, as lowercase hex. */
function traceIdFor(runId: string): string {
  return createHash('sha256').update(`oneshot-trace:${runId}`).digest('hex').slice(0, 32);
}

function spanIdFor(key: string): string {
  return createHash('sha256').update(`oneshot-span:${key}`).digest('hex').slice(0, 16);
}

type AttrValue = string | number | boolean;

function attrs(pairs: Record<string, AttrValue | undefined>): unknown[] {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([key, v]) => ({
      key,
      // intValue is a BARE NUMBER, not a string. The OTLP/JSON spec encodes
      // int64 as a string, but Langfuse's OTLP ingestion drops a string-encoded
      // intValue and renders the attribute as the literal "null" — so every
      // token count, lap and turn count would vanish. A JSON number round-trips.
      value: typeof v === 'number'
        ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v })
        : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
    }));
}

const ns = (ms: number): string => `${Math.round(ms)}000000`;

/** Every usage-ledger row for a run. */
function usageRows(runId: string): UsageRow[] {
  try {
    return db.prepare(
      `SELECT ts, phase,
              COALESCE(input, 0) AS input, COALESCE(output, 0) AS output,
              COALESCE(cache_read, 0) AS cacheRead, COALESCE(cache_creation, 0) AS cacheWrite
       FROM quota_usage WHERE run_id = ?`,
    ).all(runId) as UsageRow[];
  } catch {
    return [];
  }
}

/**
 * What one lap spent, or undefined when no ledger row falls inside it.
 *
 * The ledger has no lap column, but a session records its usage before the
 * runner stamps the lap's endedAt, so every row lands inside exactly one lap's
 * window. A row from a lap that was later pruned from the journal falls inside
 * none, and is credited to nothing rather than to a lap that did not spend it.
 */
function tokensFor(p: PhaseRecord, usage: UsageRow[]): Tokens | undefined {
  const rows = usage.filter((r) => r.phase === p.phase && r.ts >= p.startedAt && r.ts <= p.endedAt);
  if (!rows.length) return undefined;
  return rows.reduce<Tokens>(
    (sum, r) => ({
      input: sum.input + r.input,
      output: sum.output + r.output,
      cacheRead: sum.cacheRead + r.cacheRead,
      cacheWrite: sum.cacheWrite + r.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/** The run as OTLP spans: a root span for the run and one child per phase lap. */
export function runSpans(
  journal: ExportedRun,
  usage: UsageRow[],
  genAiSystem: string,
  outputFor?: (p: PhaseRecord) => string | undefined,
): unknown[] {
  const traceId = traceIdFor(journal.runId);
  const rootId = spanIdFor(journal.runId);
  const started = journal.createdAt;
  const ended = journal.phases.reduce((a, p) => Math.max(a, p.endedAt), started) || Date.now();
  const weighted = journal.phases.reduce((a, p) => a + (p.weighted ?? 0), 0);

  const spans: unknown[] = [{
    traceId,
    spanId: rootId,
    name: `oneshot #${journal.iid} ${journal.title}`.slice(0, 120),
    kind: 1,
    startTimeUnixNano: ns(started),
    endTimeUnixNano: ns(ended),
    attributes: attrs({
      'oneshot.run_id': journal.runId,
      'oneshot.ticket': journal.iid,
      'oneshot.status': journal.status,
      'oneshot.branch': journal.branch,
      'oneshot.mr_iid': journal.mrIid,
      'oneshot.merged_sha': journal.mergedSha,
      'oneshot.weighted_tokens': weighted,
      'oneshot.phases': journal.phases.length,
      'oneshot.blocked_why': journal.blockedWhy?.slice(0, 300),
      'langfuse.session.id': journal.runId,
      'langfuse.trace.name': `#${journal.iid} ${journal.title}`.slice(0, 120),
    }),
    status: { code: journal.status === 'done' ? 1 : 2 },
  }];

  for (const p of journal.phases) {
    const u = tokensFor(p, usage);
    spans.push({
      traceId,
      // Keyed by when the lap started, never by its index: pruning a failed
      // lap shifts every later index, and a new id is a second copy in Langfuse.
      spanId: spanIdFor(`${journal.runId}:${p.phase}:${p.lap}:${p.startedAt}`),
      parentSpanId: rootId,
      name: p.lap > 0 ? `${p.phase} (lap ${p.lap})` : p.phase,
      kind: 1,
      startTimeUnixNano: ns(p.startedAt),
      endTimeUnixNano: ns(p.endedAt),
      attributes: attrs({
        // gen_ai.* is what makes Langfuse render a span as a generation with
        // a model and a token count rather than a bare span.
        'gen_ai.system': genAiSystem,
        'gen_ai.request.model': p.model,
        'gen_ai.usage.input_tokens': u?.input,
        'gen_ai.usage.output_tokens': u?.output,
        'gen_ai.usage.cache_read_input_tokens': u?.cacheRead,
        'gen_ai.usage.cache_creation_input_tokens': u?.cacheWrite,
        'langfuse.observation.output': outputFor?.(p)?.slice(0, OUTPUT_CAP),
        'oneshot.phase': p.phase,
        'oneshot.lap': p.lap,
        'oneshot.status': p.status,
        'oneshot.turns': p.turns,
        'oneshot.weighted_tokens': p.weighted,
        'oneshot.session_id': p.sessionId,
        'oneshot.error': p.error?.slice(0, 300),
        'langfuse.session.id': journal.runId,
      }),
      // OTel: 1 OK, 2 ERROR, 0 UNSET. A park is a wait on a person, not an error.
      status: { code: p.status === 'ok' || p.status === 'warned' ? 1 : p.status === 'parked' ? 0 : 2 },
    });
  }
  return spans;
}

function endpoint(): string {
  const raw = otelConfig().endpoint.replace(/\/+$/, '');
  return raw.endsWith('/v1/traces') ? raw : `${raw}/v1/traces`;
}

function authHeader(): string {
  const pub = envOr('LANGFUSE_PUBLIC_KEY');
  const sec = envOr('LANGFUSE_SECRET_KEY');
  if (!pub || !sec) return '';
  return `Basic ${Buffer.from(`${pub}:${sec}`).toString('base64')}`;
}

/**
 * Send the run as one trace: a root span for the run, one child per phase lap.
 *
 * Never throws and never blocks a run on telemetry — a conductor that cannot
 * reach Langfuse has still done its job, and the journal on disk remains the
 * record of truth either way.
 */
export async function exportRun(journal: RunJournal): Promise<void> {
  const cfg = otelConfig();
  const auth = authHeader();
  if (!cfg.enabled || !auth) return;

  try {
    // Only what each session WROTE, and only while config/otel.json asks for
    // responses. Prompt text is never sent.
    const outputFor = cfg.logAssistantResponses
      ? (p: PhaseRecord) => finalResultText(transcriptPath(journal.iid, p.phase, p.lap))
      : undefined;
    const spans = runSpans(journal, usageRows(journal.runId), 'anthropic', outputFor);

    const body = {
      resourceSpans: [{
        resource: {
          attributes: attrs({
            'service.name': cfg.serviceName,
            ...cfg.resourceAttributes,
          }),
        },
        scopeSpans: [{ scope: { name: 'oneshot.conductor' }, spans }],
      }],
    };

    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(endpoint(), {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        log.info(`langfuse: exported run ${journal.runId}`, { spans: spans.length });
      } else {
        log.warn('langfuse export refused', { status: res.status });
      }
    } finally {
      clearTimeout(killer);
    }
  } catch (err) {
    log.warn('langfuse export failed', { error: (err as Error).message.slice(0, 160) });
  }
}
