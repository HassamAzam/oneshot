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
import { readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
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
    /**
     * Optional, off-by-default. A ticket carrying this label ALONGSIDE `entry`
     * gets three extra human sign-off pauses (plan, merge, qa) — see
     * src/conductor/reviewgate.ts and README's "Optional human review gates".
     * Never required, never swapped by Oneshot, and absent entirely changes
     * nothing: every check that reads it is an additive `labels.includes(...)`.
     */
    review: string;
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
  /**
   * Concurrency marker. A maximal run of CONSECUTIVE phases sharing a group
   * value is dispatched together, so a group is only ever as wide as the
   * phases.json ordering allows — which is what keeps the config readable as a
   * sequence and stops a stray group name from parallelising two phases that
   * happen to be far apart.
   */
  group?: string;
  /**
   * A phase the executor never SCHEDULES. It still carries a position in the
   * list, a model tier, a turn cap and a write scope like any other — it is
   * simply invoked by name at the moment something needs it, and stepped over
   * by the main loop.
   *
   * The position matters even though the loop skips it: `n` is what keeps the
   * phase in the ordering the config reads as a sequence, and being in the list
   * at all is what lets ONESHOT_SKIP_PHASES switch it off exactly like the rest.
   */
  onDemand?: boolean;
}

export interface BudgetConfig {
  /** false disables every self-imposed token ceiling below. Absent means enabled. */
  enabled?: boolean;
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

export const DRY_RUN = envFlag('DRY_RUN');
export const SKIP_DEPLOY = envFlag('ONESHOT_SKIP_DEPLOY');

/**
 * The conductor's own tick cadence — how often `src/index.ts` scans for
 * claimable tickets. Exported so anything that needs to describe its own
 * cadence as "the same as the tick loop" (e.g. the review-gate park state in
 * src/conductor/reviewgate.ts, which relies on being re-checked on the next
 * scan rather than running its own timer) points at the one number instead of
 * repeating it.
 */
export const TICK_MS = 60_000;

/**
 * A dry run's own home, so DRY_RUN=1 cannot disturb the conductors doing real
 * work.
 *
 * Sharing state/ was the flaw: a dry run's rows sat in the same claim table and
 * the same port pool as everybody else's, so it hid tickets from the watcher and
 * held ports nothing was listening on, and its journals were what a resumed real
 * run read back. "Changes nothing" has to mean changes nothing HERE too, not
 * just nothing on GitLab.
 *
 * It is a whole shadow home rather than a bare directory because the guard hooks
 * have to agree. hooks/_common.cjs derives everything it reads from
 * `$ONESHOT_HOME` — state/ for the journals and the pause switches, config/ for
 * the branch policy, .env for the token — and deploy-guard refuses outright when
 * it cannot read the run journal. So state-dry/ carries its own state/ and
 * borrows the other two by symlink, and ONESHOT_HOME points at it: the hooks
 * then resolve the same configuration the conductor loaded and the same journals
 * the dry run is writing.
 */
function dryHome(): string {
  const home = join(ROOT, 'state-dry');
  mkdirSync(join(home, 'state'), { recursive: true });
  for (const shared of ['config', '.env']) {
    const link = join(home, shared);
    if (existsSync(link) || !existsSync(join(ROOT, shared))) continue;
    try {
      symlinkSync(join(ROOT, shared), link);
    } catch { /* another dry conductor got there first */ }
  }
  return home;
}

export const ONESHOT_HOME: string = DRY_RUN ? dryHome() : ROOT;

export const STATE = join(ONESHOT_HOME, 'state');
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
    ONESHOT_HOME,
  };

  // Committer identity travels in the environment rather than in a config file.
  // `git config user.name` inside a worktree writes the SHARED .git/config, so
  // several worktrees being created at once contend for one lock and most of
  // them lose. Nothing needs a file: git reads these four variables directly,
  // they are per-session by construction, and a worktree that is deleted takes
  // no configuration with it.
  const gitAuthor = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const gitEmail = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  env.GIT_AUTHOR_NAME = gitAuthor;
  env.GIT_COMMITTER_NAME = gitAuthor;
  if (gitEmail) {
    env.GIT_AUTHOR_EMAIL = gitEmail;
    env.GIT_COMMITTER_EMAIL = gitEmail;
  }

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
 * Reports variable NAMES only, never values. `apiKeyHelper` is a NOTE rather
 * than a problem: phase sessions load `settingSources: ['project']` only
 * (src/conductor/phase.ts), so a helper configured at user level never runs for
 * one. It is still worth saying, because it does run for the operator's own
 * interactive sessions on the same machine — the thing this audit is really
 * about is nobody discovering a metered bill by accident.
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
        notes.push(
          'apiKeyHelper is configured in ~/.claude/settings.json. Phase sessions load ' +
          'project settings only, so it does NOT run for them — but it does run for ' +
          'interactive sessions here, and its key outranks subscription OAuth.',
        );
      }
    } catch { /* unreadable settings is not an auth problem */ }
  }

  const credential = BASE_ENV.CLAUDE_CODE_OAUTH_TOKEN
    ? 'CLAUDE_CODE_OAUTH_TOKEN (subscription)'
    : 'keychain OAuth from `claude login` (subscription)';

  return { clean: problems.length === 0, credential, problems, notes };
}
