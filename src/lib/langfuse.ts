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
 * outcomes — the shape people actually open Langfuse to see. The full per-turn
 * record was never in Langfuse anyway; it is on disk, in
 * state/runs/<iid>/transcripts/.
 *
 * Ids are DERIVED rather than random, so re-exporting a run updates its spans
 * instead of duplicating them. That is what lets this be called after every
 * phase and again at the end without any bookkeeping.
 */
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { envOr } from './config.js';
import { otelConfig } from './otel.js';
import { log } from './log.js';
import type { RunJournal } from './artifacts.js';

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
      value: typeof v === 'number'
        ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
        : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
    }));
}

const ns = (ms: number): string => `${Math.round(ms)}000000`;

/** Raw token counts for a run, per phase, from the usage ledger. */
function usageByPhase(runId: string): Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> {
  const out = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  try {
    const rows = db.prepare(
      `SELECT phase,
              SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(cache_creation) AS cache_creation
       FROM quota_usage WHERE run_id = ? GROUP BY phase`,
    ).all(runId) as Array<{ phase: string; input: number; output: number; cache_read: number; cache_creation: number }>;
    for (const r of rows) {
      out.set(r.phase, {
        input: r.input ?? 0, output: r.output ?? 0,
        cacheRead: r.cache_read ?? 0, cacheWrite: r.cache_creation ?? 0,
      });
    }
  } catch { /* the ledger is a nicety here, not a precondition */ }
  return out;
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
    const traceId = traceIdFor(journal.runId);
    const rootId = spanIdFor(journal.runId);
    const usage = usageByPhase(journal.runId);
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
        'oneshot.deployed_sha': journal.deployedSha,
        'oneshot.weighted_tokens': weighted,
        'oneshot.phases': journal.phases.length,
        'oneshot.blocked_why': journal.blockedWhy?.slice(0, 300),
        'langfuse.session.id': journal.runId,
        'langfuse.trace.name': `#${journal.iid} ${journal.title}`.slice(0, 120),
      }),
      status: { code: journal.status === 'done' ? 1 : 2 },
    }];

    for (const [i, p] of journal.phases.entries()) {
      const u = usage.get(p.phase);
      spans.push({
        traceId,
        spanId: spanIdFor(`${journal.runId}:${p.phase}:${p.lap}:${i}`),
        parentSpanId: rootId,
        name: p.lap > 0 ? `${p.phase} (lap ${p.lap})` : p.phase,
        kind: 1,
        startTimeUnixNano: ns(p.startedAt),
        endTimeUnixNano: ns(p.endedAt),
        attributes: attrs({
          // gen_ai.* is what makes Langfuse render a span as a generation with
          // a model and a token count rather than a bare span.
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': p.model,
          'gen_ai.usage.input_tokens': u?.input,
          'gen_ai.usage.output_tokens': u?.output,
          'gen_ai.usage.cache_read_input_tokens': u?.cacheRead,
          'gen_ai.usage.cache_creation_input_tokens': u?.cacheWrite,
          'oneshot.phase': p.phase,
          'oneshot.lap': p.lap,
          'oneshot.status': p.status,
          'oneshot.turns': p.turns,
          'oneshot.weighted_tokens': p.weighted,
          'oneshot.session_id': p.sessionId,
          'oneshot.error': p.error?.slice(0, 300),
          'langfuse.session.id': journal.runId,
        }),
        status: { code: p.status === 'ok' || p.status === 'warned' ? 1 : 2 },
      });
    }

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
