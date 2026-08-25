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
  allowRemote: boolean;
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
    // LANGFUSE_BASE_URL is what the Langfuse UI hands you, so accept it directly
    // rather than making the operator hand-append the OTLP path.
    const fromBase = envOr('LANGFUSE_BASE_URL')
      ? `${envOr('LANGFUSE_BASE_URL').replace(/\/+$/, '')}/api/public/otel`
      : '';
    raw.endpoint = envOr('ONESHOT_OTEL_ENDPOINT', fromBase || raw.endpoint);

    // ONESHOT_OTEL=0 kills telemetry for one run without editing tracked config.
    const override = envOr('ONESHOT_OTEL');
    if (override === '0' || override.toLowerCase() === 'false') raw.enabled = false;
    if (override === '1' || override.toLowerCase() === 'true') raw.enabled = true;

    if (envFlag('ONESHOT_OTEL_ALLOW_REMOTE')) raw.allowRemote = true;
    _cfg = raw;
  }
  return _cfg;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

/** True when the endpoint sends span metadata off this machine. */
export function isRemoteEndpoint(endpoint: string): boolean {
  try {
    return !LOOPBACK.test(new URL(endpoint).hostname);
  } catch {
    // An unparseable endpoint is treated as remote: fail toward not shipping.
    return true;
  }
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

  if (isRemoteEndpoint(c.endpoint) && !c.allowRemote) {
    process.stderr.write(
      `[otel] ${c.endpoint} is not loopback and allowRemote is false — telemetry disabled.\n` +
      '[otel] Spans carry tool names, file paths and command arguments from a private\n' +
      '[otel] repo. Either self-host (docker compose -f docker-compose.langfuse.yml up -d)\n' +
      '[otel] or set allowRemote: true in config/otel.json to send that metadata off-machine.\n',
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
export function otelStatus(): { on: boolean; why: string; remote: boolean } {
  const c = otelConfig();
  const remote = isRemoteEndpoint(c.endpoint);
  if (!c.enabled) {
    return { on: false, remote, why: 'disabled in config/otel.json (or ONESHOT_OTEL=0)' };
  }
  if (!authHeader()) {
    return { on: false, remote, why: 'LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset' };
  }
  if (remote && !c.allowRemote) {
    return {
      on: false, remote,
      why: `${c.endpoint} is remote and allowRemote is false — set it to opt in, or self-host`,
    };
  }
  let why = c.endpoint;
  if (remote) why += ' (remote)';
  if (c.logAssistantResponses) why += ' +responses';
  if (c.logUserPrompts) why += ' +PROMPTS';
  return { on: true, remote, why };
}

/**
 * Whether prompt text is being exported.
 *
 * Split out from responses because the two are not comparable. Responses are
 * output-only and never replayed, so they are cheap and useful. Prompts carry
 * the whole conversation plus every file read, on every turn — expensive, and
 * the flag that makes the span store a second copy of every ticket and diff.
 * `doctor` fails on this one and merely notes the other.
 */
export function promptTextExported(): boolean {
  const c = otelConfig();
  return c.enabled && c.logUserPrompts && !!authHeader();
}
