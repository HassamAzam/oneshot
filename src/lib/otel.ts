/**
 * Native Claude Code OpenTelemetry -> Langfuse.
 *
 * Oneshot writes no instrumentation. The Agent SDK spawns the Claude Code CLI
 * and the CLI emits OTLP on its own; all this module does is put the right
 * variables in the session environment. It cannot be done from the shell:
 * buildBaseEnv() in config.ts REPLACES the subprocess environment, so an
 * OTEL_* exported by the operator would be stripped along with everything else.
 *
 * The mapping to Langfuse:
 *   session  = one ticket run   (langfuse.session.id = run id)
 *   trace    = one phase
 *   span     = one tool call / subagent
 *   generation = one model request, with tokens
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, envOr, envFlag } from './config.js';

export interface OtelConfig {
  enabled: boolean;
  endpoint: string;
  protocol: string;
  serviceName: string;
  exporters: { traces: string; metrics: string; logs: string };
  logToolDetails: boolean;
  logUserPrompts: boolean;
  logAssistantResponses: boolean;
  spanScheduleDelayMs: number;
  exporterTimeoutMs: number;
  metricExportIntervalMs: number;
  logsExportIntervalMs: number;
  sessionAttribute: string;
  resourceAttributes: Record<string, string>;
}

let _cfg: OtelConfig | null = null;

export function otelConfig(): OtelConfig {
  if (!_cfg) {
    const raw = JSON.parse(
      readFileSync(join(ROOT, 'config', 'otel.json'), 'utf8'),
    ) as OtelConfig;
    raw.endpoint = envOr('ONESHOT_OTEL_ENDPOINT', raw.endpoint);
    // ONESHOT_OTEL=0 kills telemetry for one run without editing tracked config.
    const override = envOr('ONESHOT_OTEL');
    if (override === '0' || override.toLowerCase() === 'false') raw.enabled = false;
    if (override === '1' || override.toLowerCase() === 'true') raw.enabled = true;
    _cfg = raw;
  }
  return _cfg;
}

/**
 * Langfuse authenticates OTLP with HTTP Basic over base64(public:secret).
 * Returns '' when either key is missing, which disables telemetry rather than
 * shipping spans at an endpoint that will reject them for the whole run.
 */
function authHeader(): string {
  const pub = envOr('LANGFUSE_PUBLIC_KEY');
  const sec = envOr('LANGFUSE_SECRET_KEY');
  if (!pub || !sec) return '';
  return `Basic ${Buffer.from(`${pub}:${sec}`).toString('base64')}`;
}

/** Constants for every session — the half that belongs in BASE_ENV. */
export function otelBaseEnv(): Record<string, string> {
  const c = otelConfig();
  if (!c.enabled) return {};

  const auth = authHeader();
  if (!auth) {
    // Deliberately loud: silent telemetry-off is how you discover three days
    // later that no run was ever recorded.
    process.stderr.write(
      '[otel] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset — telemetry disabled.\n',
    );
    return {};
  }

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    // REQUIRED for spans. Without it you get metrics and logs only, and the
    // phase -> tool -> subagent tree never appears — which is the whole point.
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: c.exporters.traces,
    OTEL_METRICS_EXPORTER: c.exporters.metrics,
    OTEL_LOGS_EXPORTER: c.exporters.logs,
    OTEL_EXPORTER_OTLP_PROTOCOL: c.protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${auth}`,
    OTEL_SERVICE_NAME: c.serviceName,
  };

  if (c.logToolDetails) env.OTEL_LOG_TOOL_DETAILS = '1';
  if (c.logUserPrompts) env.OTEL_LOG_USER_PROMPTS = '1';
  if (c.logAssistantResponses) env.OTEL_LOG_ASSISTANT_RESPONSES = '1';
  if (c.spanScheduleDelayMs > 0) env.OTEL_BSP_SCHEDULE_DELAY = String(c.spanScheduleDelayMs);
  if (c.exporterTimeoutMs > 0) env.OTEL_EXPORTER_OTLP_TIMEOUT = String(c.exporterTimeoutMs);
  if (c.metricExportIntervalMs > 0) env.OTEL_METRIC_EXPORT_INTERVAL = String(c.metricExportIntervalMs);
  if (c.logsExportIntervalMs > 0) env.OTEL_LOGS_EXPORT_INTERVAL = String(c.logsExportIntervalMs);

  return env;
}

export interface SpawnIdentity {
  runId: string;
  ticket: number;
  phase: string;
  lap: number;
  tier: string;
  model: string;
}

/**
 * Per-spawn resource attributes — the half that changes on every phase.
 *
 * Percent-encoded before joining: OTEL_RESOURCE_ATTRIBUTES is a comma-separated
 * k=v list, so an unescaped comma or equals sign in a value silently corrupts
 * every attribute after it.
 */
export function otelSpawnEnv(id: SpawnIdentity): Record<string, string> {
  const c = otelConfig();
  if (!c.enabled || !authHeader()) return {};

  const attrs: Record<string, string> = {
    ...c.resourceAttributes,
    // Langfuse groups traces into a session by this attribute, so every phase
    // of one ticket lands in one session view.
    [c.sessionAttribute]: id.runId,
    'oneshot.run_id': id.runId,
    'oneshot.ticket': String(id.ticket),
    'oneshot.phase': id.phase,
    'oneshot.lap': String(id.lap),
    'oneshot.tier': id.tier,
    'oneshot.model': id.model,
  };

  const encoded = Object.entries(attrs)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(',');

  return { OTEL_RESOURCE_ATTRIBUTES: encoded };
}

/** Reported by `npm run doctor`. */
export function otelStatus(): { on: boolean; why: string } {
  const c = otelConfig();
  if (!c.enabled) return { on: false, why: 'disabled in config/otel.json (or ONESHOT_OTEL=0)' };
  if (!authHeader()) return { on: false, why: 'LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset' };
  const leaks: string[] = [];
  if (c.logUserPrompts) leaks.push('prompts');
  if (c.logAssistantResponses) leaks.push('responses');
  const suffix = leaks.length ? ` — WARNING: ${leaks.join(' + ')} text is being exported` : '';
  return { on: true, why: `${c.endpoint}${suffix}` };
}
