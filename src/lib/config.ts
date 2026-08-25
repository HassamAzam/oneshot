/**
 * Config loading, path resolution, and the scrubbed environment handed to
 * every phase session.
 *
 * The env-building half of this file is the most safety-critical code in the
 * repo. The Agent SDK's `env` option REPLACES the subprocess environment
 * rather than merging into it, which is precisely what makes it a control: a
 * variable reaches a session only if it is written here. That is how
 * ANTHROPIC_API_KEY is kept out — in headless/SDK mode Claude Code never
 * prompts about a detected key, it silently uses it, and a subscription fleet
 * becomes a metered API bill with no signal that anything changed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';

export const ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

loadDotenv({ path: join(ROOT, '.env'), quiet: true });

/**
 * Read an env var, accepting the legacy ONELOOP_ spelling for any ONESHOT_
 * name so an existing One Loop .env keeps working. ONESHOT_ wins.
 */
/**
 * An unreplaced placeholder from .env.example.
 *
 * Treated as unset, not as a value. Otherwise `SLACK_BOT_TOKEN=xoxb-REPLACE_ME`
 * satisfies every "is it configured" check and the failure only surfaces later
 * as an opaque `invalid_auth` from the API.
 */
export function isPlaceholder(v: string): boolean {
  return /REPLACE_ME|<[a-z-]+>|CHANGE_?ME|your-.*-here/i.test(v);
}

export function envOr(name: string, fallback = ''): string {
  const primary = process.env[name];
  if (typeof primary === 'string' && primary !== '' && !isPlaceholder(primary)) return primary;
  if (name.startsWith('ONESHOT_')) {
    const legacy = process.env[`ONELOOP_${name.slice('ONESHOT_'.length)}`];
    if (typeof legacy === 'string' && legacy !== '' && !isPlaceholder(legacy)) return legacy;
  }
  return fallback;
}

export function envFlag(name: string): boolean {
  const v = envOr(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Expand a leading `~` and resolve relative paths against the repo root. */
export function expandPath(p: string): string {
  if (!p) return '';
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(expanded) ? expanded : resolve(ROOT, expanded);
}

// --------------------------------------------------------------- config files

function loadJson<T>(name: string): T {
  const path = join(ROOT, 'config', name);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Cannot read config/${name}: ${(err as Error).message}`);
  }
}

export interface ProjectConfig {
  gitlab: { host: string; apiUrl: string; project: string; projectId: number };
  contextRepo: { path: string; gitlabProject: string; skillsRoot: string };
  labels: {
    entry: string; entryId: number;
    exit: string; exitId: number;
    blocked: string; blockedId: number;
  };
  preserveLabels: string[];
  branches: { base: string; protected: string[]; prefix: string; pattern: string };
  promotions: Array<{ from: string; to: string; auto: boolean }>;
  concurrency: number;
}

export interface PhaseConfig {
  name: string;
  n: number;
  kind: 'session' | 'code';
  tier?: 'heavy' | 'standard' | 'light';
  cwd?: 'worktree' | 'conductor';
  maxTurns?: number;
  timeoutMin: number;
  writes?: string[];
  onFail: 'skip' | 'warn' | 'abort' | 'retry' | 'cycle' | 'blocked';
  maxRetries?: number;
  cycleTo?: string;
  maxLaps?: number;
  coding?: boolean;
  needsPort?: boolean;
  skills?: string[];
  agents?: string[];
  artifact?: string;
}

export interface BudgetConfig {
  weights: { input: number; output: number; cache_creation: number; cache_read: number };
  window_hours: number;
  window_tokens: number;
  day_tokens: number;
  warn_pct: number;
  reserve: {
    pause_at_five_hour_pct: number;
    pause_at_seven_day_pct: number;
    signal_max_age_min: number;
  };
  ticket_tokens: number;
  phases: Record<string, number>;
  pause_defaults: { session_minutes: number; weekly_minutes: number };
}

export interface DeployConfig {
  script: string;
  args: string[];
  server: string;
  allowedHosts: string[];
  vpnGated: boolean;
  allowedRefs: string[];
  defaultRef: string;
  healthUrl: string;
  healthHostHeader: string;
  expectStatus: number;
  depFlags: Record<string, string>;
  timeoutMin: number;
  demoUrl: string;
}

export interface SlackConfig {
  channel: string;
  card: { editInPlace: boolean; showTokens: boolean; showElapsed: boolean; showModel: boolean };
  milestones: string[];
  mentionOn: string[];
  allowlist: string[];
  verbs: Record<string, string>;
  filler: string[];
  maxTextLen: number;
  maxCommandsPerActorPerHour: number;
  requireMention: boolean;
}

let _project: ProjectConfig | null = null;
export function projectConfig(): ProjectConfig {
  if (!_project) {
    const c = loadJson<ProjectConfig>('project.json');
    c.gitlab.apiUrl = envOr('ONESHOT_GITLAB_API', c.gitlab.apiUrl);
    c.gitlab.project = envOr('ONESHOT_GITLAB_PROJECT', c.gitlab.project);
    const idOverride = envOr('ONESHOT_PROJECT_ID');
    if (idOverride) c.gitlab.projectId = Number(idOverride);
    _project = c;
  }
  return _project;
}

let _phases: PhaseConfig[] | null = null;
export function phases(): PhaseConfig[] {
  if (!_phases) {
    const skip = new Set(
      envOr('ONESHOT_SKIP_PHASES').split(',').map((s) => s.trim()).filter(Boolean),
    );
    _phases = loadJson<{ phases: PhaseConfig[] }>('phases.json').phases
      .filter((p) => !skip.has(p.name))
      .sort((a, b) => a.n - b.n);
  }
  return _phases;
}

export function phaseByName(name: string): PhaseConfig | undefined {
  return phases().find((p) => p.name === name);
}

let _budgets: BudgetConfig | null = null;
export function budgetConfig(): BudgetConfig {
  if (!_budgets) {
    const c = loadJson<BudgetConfig>('budgets.json');
    const w = envOr('ONESHOT_WINDOW_TOKENS');
    const d = envOr('ONESHOT_DAY_TOKENS');
    const r = envOr('ONESHOT_RESERVE_PCT');
    if (w) c.window_tokens = Number(w);
    if (d) c.day_tokens = Number(d);
    if (r) c.reserve.pause_at_five_hour_pct = Number(r);
    _budgets = c;
  }
  return _budgets;
}

let _deploy: DeployConfig | null = null;
export function deployConfig(): DeployConfig {
  if (!_deploy) {
    const c = loadJson<DeployConfig>('deploy.json');
    c.server = envOr('ONESHOT_DEPLOY_SERVER', c.server);
    c.demoUrl = envOr('ONESHOT_DEMO_URL', c.demoUrl);
    _deploy = c;
  }
  return _deploy;
}

let _slack: SlackConfig | null = null;
export function slackConfig(): SlackConfig {
  if (!_slack) {
    const c = loadJson<SlackConfig>('slack.json');
    c.channel = envOr('ONESHOT_CHANNEL', c.channel);
    _slack = c;
  }
  return _slack;
}

export function modelFor(phase: PhaseConfig): string {
  const m = loadJson<{
    tiers: Record<string, string>;
    narrator: string;
    overrides: Record<string, string>;
  }>('models.json');
  const tier = m.overrides[phase.name] ?? phase.tier ?? 'standard';
  const model = m.tiers[tier];
  if (!model) throw new Error(`config/models.json has no tier '${tier}' (phase ${phase.name})`);
  return model;
}

export function narratorModel(): string {
  const m = loadJson<{ tiers: Record<string, string>; narrator: string }>('models.json');
  return m.tiers[m.narrator] ?? m.tiers.light ?? 'claude-haiku-4-5-20251001';
}

// ------------------------------------------------------------------ paths

export const STATE = join(ROOT, 'state');
export const RUNS = join(STATE, 'runs');
export const MEMORY = join(STATE, 'memory');
export const PAUSE = join(STATE, 'PAUSE');
export const PAUSE_QUOTA = join(STATE, 'PAUSE-QUOTA');
export const PAUSE_NETWORK = join(STATE, 'PAUSE-NETWORK');
export const PAUSE_DEPLOY = join(STATE, 'PAUSE-DEPLOY');
export const DB_PATH = join(STATE, 'oneshot.db');

export const WORK_REPO = expandPath(envOr('WORK_REPO', '~/Documents/workstreamai'));
export const CONTEXT_REPO = expandPath(envOr('CONTEXT_REPO', '~/Documents/erp'));
export const SKILLS_ROOT = expandPath(envOr('ONESHOT_SKILLS_ROOT', '~/Documents/erp/.claude'));
export const WT_ROOT = expandPath(envOr('WT_ROOT', '~/Documents/oneshot-wt'));

export function runDir(iid: number): string { return join(RUNS, String(iid)); }
export function artifactDir(iid: number): string { return join(runDir(iid), 'artifacts'); }

export function portPool(): number[] {
  return envOr('PORT_POOL', '8000,8001,8002')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export const DRY_RUN = envFlag('DRY_RUN');
export const SKIP_DEPLOY = envFlag('ONESHOT_SKIP_DEPLOY');

// -------------------------------------------------------------- session env

/**
 * Credential variables that must NEVER reach a session.
 *
 * Deleted, not blanked: an EMPTY ANTHROPIC_API_KEY still occupies its slot in
 * Claude Code's credential precedence and still outranks subscription OAuth.
 */
const AUTH_VARS_NEVER_FORWARDED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * The subset whose mere presence is a billing risk.
 *
 * ANTHROPIC_BASE_URL is deliberately NOT here. Claude Code sets it to the
 * canonical endpoint for its own process, so treating any value as a problem
 * fires on a completely healthy machine. It only matters when it points
 * somewhere other than Anthropic — that is a proxy, and worth saying so.
 */
const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const CANONICAL_API_HOSTS = ['api.anthropic.com'];

/**
 * Identity variables the OAuth keychain lookup needs. Not secrets — without
 * them the macOS keychain cannot resolve the login and a subscription session
 * fails to authenticate at all.
 */
const IDENTITY_VARS = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR'] as const;

function defaultSessionPath(): string {
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean);
  const nodeDir = dirname(process.execPath);
  if (nodeDir && !parts.includes(nodeDir)) parts.unshift(nodeDir);
  for (const fallback of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']) {
    if (!parts.includes(fallback)) parts.push(fallback);
  }
  return parts.join(':');
}

function buildBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: envOr('ONESHOT_SESSION_PATH', defaultSessionPath()),
    HOME: process.env.HOME ?? homedir(),
    LANG: 'en_US.UTF-8',
    ONESHOT_HOME: ROOT,
  };

  for (const v of IDENTITY_VARS) {
    const val = process.env[v];
    if (typeof val === 'string' && val !== '') env[v] = val;
  }

  // The 1M context window consumes purchased usage credits even when
  // subscription allowance remains — that is a real charge, unlike everything
  // else here.
  if (!envFlag('ONESHOT_ALLOW_1M_CONTEXT')) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';

  // Only for a headless box with no interactive login. Subscription credential.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof oauth === 'string' && oauth.trim() !== '') env.CLAUDE_CODE_OAUTH_TOKEN = oauth;

  for (const v of AUTH_VARS_NEVER_FORWARDED) delete env[v];
  return env;
}

/**
 * The auth-and-identity half of the session environment.
 *
 * Telemetry is deliberately NOT merged here. otel.ts imports this module, so
 * calling into it during BASE_ENV's module-init would be an import cycle
 * evaluated at exactly the wrong moment. The phase runner composes the full
 * environment instead:
 *
 *   { ...BASE_ENV, ...otelBaseEnv(), ...otelSpawnEnv(identity), ...phaseVars }
 *
 * which also keeps this constant about one thing: keeping metered-billing
 * credentials out of sessions.
 */
export const BASE_ENV: Record<string, string> = buildBaseEnv();

export interface AuthReport {
  clean: boolean;
  credential: string;
  /** Would bill to an API key. Fails `doctor`. */
  problems: string[];
  /** Worth knowing, not a billing risk. Warns only. */
  notes: string[];
}

/**
 * Report which credential a session will actually use.
 *
 * Reports variable NAMES only, never values. `apiKeyHelper` matters because
 * sessions load user settings (settingSources includes 'user'), so a helper
 * configured there WOULD run and its output outranks subscription OAuth.
 */
export function auditAuth(): AuthReport {
  const problems: string[] = [];
  const notes: string[] = [];

  for (const v of CREDENTIAL_VARS) {
    if (typeof process.env[v] === 'string' && process.env[v] !== '') {
      problems.push(
        `${v} is set in this shell. It is stripped from session env, so Oneshot is ` +
        'unaffected, but an interactive session on this machine may be billing to an API key.',
      );
    }
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      if (!CANONICAL_API_HOSTS.includes(host)) {
        notes.push(
          `ANTHROPIC_BASE_URL points at ${host}, not Anthropic. Sessions are routed ` +
          'through a proxy. It is stripped from session env, so Oneshot goes direct.',
        );
      }
    } catch {
      notes.push(`ANTHROPIC_BASE_URL is set but unparseable: ${baseUrl}`);
    }
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { apiKeyHelper?: unknown };
      if (s.apiKeyHelper) {
        problems.push(
          'apiKeyHelper is configured in ~/.claude/settings.json. Sessions load user ' +
          'settings, so it WILL run and its key outranks subscription OAuth.',
        );
      }
    } catch { /* unreadable settings is not an auth problem */ }
  }

  const credential = BASE_ENV.CLAUDE_CODE_OAUTH_TOKEN
    ? 'CLAUDE_CODE_OAUTH_TOKEN (subscription)'
    : 'keychain OAuth from `claude login` (subscription)';

  return { clean: problems.length === 0, credential, problems, notes };
}
