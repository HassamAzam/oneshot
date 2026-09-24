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
import { readFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, userInfo } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { deskUsername } from './identity.js';
import { parseMrFeedbackConfig } from '../mrfeedback/config.js';
import type { MrFeedbackConfig } from '../mrfeedback/types.js';

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
  if (/REPLACE_ME|<[a-z-]+>|CHANGE_?ME|your-.*-here/i.test(v)) return true;
  // Stand-in PATHS, which the patterns above do not catch because they look
  // like ordinary paths. A documented example such as `~/their/path/erp` gets
  // pasted verbatim, `~` expands, and the result is a real-looking absolute
  // path to a directory nobody created — reported as a missing checkout, with
  // a suggestion to clone into it. Treating it as unset surfaces it as what it
  // is: a value still waiting to be filled in.
  return /(^|\/)(their|your|my|some)[-_/]path(\/|$)|(^|\/)path[-_/]to(\/|$)/i.test(v);
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

/**
 * Whose desk this conductor is.
 *
 * Shown on the Slack card so several loops sharing one channel are tellable
 * apart, and written into the ticket's claim note so a person reading it can
 * see who to talk to. ONESHOT_OPERATOR is explicit; BOARD_OPERATOR is the same
 * fact the telemetry board already asks for, so a desk configured for the
 * board needs nothing more; the OS username is what both of those default to
 * on the board side too. Never the git author — that is deliberately the bot.
 */
export function operatorName(): string {
  const explicit = envOr('ONESHOT_OPERATOR') || envOr('BOARD_OPERATOR');
  if (explicit) return explicit;
  try { return userInfo().username; } catch { return 'oneshot'; }
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
    // Null while a label's id has not been verified against the live project.
    // Nothing reads these ids — every check is by name — so an unverified
    // label costs nothing except the reminder that it must already exist.
    exit: string; exitId: number | null;
    blocked: string; blockedId: number;
    /**
     * Optional, off-by-default. A ticket carrying this label ALONGSIDE `entry`
     * gets three extra human sign-off pauses (plan, testcases, merge) — see
     * src/conductor/reviewgate.ts and README's "Optional human review gates".
     * Never required, never swapped by Oneshot, and absent entirely changes
     * nothing: every check that reads it is an additive `labels.includes(...)`.
     */
    review: string;
    /**
     * Optional, off-by-default board marker — never required, never gates
     * anything. Swapped onto the ticket the moment the testcases gate first
     * posts its request comment, and off again the moment that gate is
     * approved. See src/conductor/reviewgate.ts.
     */
    testcaseReview: string;
    designReview: string;
    /**
     * Put on a ticket whose reported defect `research` could not reproduce on the
     * base branch, in place of the entry label. Must exist on the project; unset
     * means the run still stops and says why, but no label is added.
     */
    notABug?: string;
    /**
     * Put on the ticket while its MR waits for a person to merge it, and taken
     * off when the run finishes or blocks — so the board shows which tickets are
     * waiting on a reviewer. Unset disables it.
     */
    inReview?: string;
  };
  /**
   * Reproduce a reported bug on the base branch during `research` before any
   * fix is planned (skill: bug-reproduction). A run whose defect does not
   * reproduce stops, is labelled `labels.notABug`, and says so on the ticket
   * and in Slack. False turns the whole step off.
   *
   * The project-wide half of the switch. The per-ticket half is the label
   * mapped to `bug-reproduction` in the research phase's `labelSkills`: both
   * must be true, so this being on does not mean every run reproduces.
   */
  bugReproduction?: boolean;
  /**
   * Apply the review gates to EVERY run, not only to tickets carrying `labels.review`
   * or touching `highScrutinyPaths`. A change of posture rather than a tuning knob:
   * with it on, every run pauses after `plan` and after `testcases`, and never merges
   * its own MR. The label and the path list are still honoured and still matter — they
   * are what keeps the consequential tickets gated if this is switched back off.
   */
  reviewAllRuns?: boolean;
  /**
   * Repo-relative path fragments whose modules are too consequential to ship
   * unwatched. A run whose plan or diff touches one gets the `Review` label's
   * gates whether or not anybody remembered to apply the label — see
   * `highScrutinyHits()` in src/conductor/reviewgate.ts. Derived at load from the
   * `paths` of every module in config/risk-modules.json, so emptying this array
   * disables nothing — drop a module's `paths` there instead.
   */
  highScrutinyPaths: string[];
  preserveLabels: string[];
  branches: { base: string; protected: string[]; prefix: string; pattern: string };
  promotions: Array<{ from: string; to: string; auto: boolean }>;
  concurrency: number;
  /**
   * Named overlays selected by ONESHOT_PROJECT. Absent or unselected, nothing
   * here is read and every field above stands as written.
   */
  targets?: Record<string, TargetConfig>;
}

/**
 * One named target: which project Oneshot works on, and where that project
 * lives on this machine. Every field is optional — a target overrides only
 * what it names, so a target that differs from the default in one respect
 * says one thing.
 */
export interface TargetConfig {
  gitlab?: { project?: string; projectId?: number };
  workRepo?: string;
  seedFrom?: string;
  wtRoot?: string;
  branches?: { base?: string };
  labels?: Partial<ProjectConfig['labels']>;
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
  /** Loaded for every ticket this phase runs on. */
  skills?: string[];
  /**
   * Ticket label -> the skill that label calls for, loaded only when the
   * ticket carries it.
   *
   * Data rather than a predicate in code, because that is all it is: a label
   * is set by whoever triages and read here, with nothing to compute. Keeping
   * it in the config is what makes the next one a single line — the skills a
   * phase can load, and the labels that decide them, are then answerable
   * without reading TypeScript.
   */
  labelSkills?: Record<string, string>;
  /**
   * A phase that runs ONLY when the ticket carries this label.
   *
   * Read case-insensitively, for the reason `labelSkills` already gives: a
   * label is typed by hand, and `design` versus `Design` must not be the
   * difference between a phase running and not when the failure is silent
   * either way.
   *
   * Applied by FILTERING the phase out of the run's list, not by skipping it
   * inside the loop. Not for an arithmetic reason: `cycleTo` resolves by name
   * and a gated phase need not carry a group, so skipping one in place breaks
   * nothing today. Filtering is the honest representation — the list a run
   * walks is the list of phases that ran, and nobody reading a journal later
   * has to work out which entries were inert.
   *
   * Not `onDemand`: that means "never scheduled, invoked out of band by the
   * conductor when something needs it" (remediate, mr-feedback). This one is
   * scheduled, in order, for the tickets it applies to.
   */
  labelGated?: string;
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

/**
 * Which project this conductor works on, from ONESHOT_PROJECT in .env.
 *
 * Empty is the whole backwards-compatibility story: no target is selected, no
 * overlay is applied, and every path and label resolves exactly as it did
 * before targets existed. The variable is read once and lower-cased so `ERP`,
 * `erp` and `Erp` are one target rather than three misses.
 */
export const PROJECT_TARGET: string = envOr('ONESHOT_PROJECT').trim().toLowerCase();

/**
 * The selected overlay, or null when none is selected.
 *
 * An UNKNOWN name throws rather than falling back. A typo that silently left
 * the conductor pointed at the default project would be the worst possible
 * failure of a switch whose entire job is to move it: tickets would be claimed,
 * branches cut and MRs opened against a project nobody meant to touch, and
 * nothing in the logs would look wrong.
 */
let _target: TargetConfig | null | undefined;
export function activeTarget(): TargetConfig | null {
  if (_target === undefined) {
    if (!PROJECT_TARGET) {
      _target = null;
    } else {
      const targets = loadJson<ProjectConfig>('project.json').targets ?? {};
      const found = targets[PROJECT_TARGET];
      if (!found) {
        const known = Object.keys(targets);
        throw new Error(
          `ONESHOT_PROJECT='${PROJECT_TARGET}' is not a target in config/project.json. `
          + (known.length ? `Known targets: ${known.join(', ')}. ` : 'No targets are defined. ')
          + 'Unset it to work on the default project.',
        );
      }
      _target = found;
    }
  }
  return _target;
}

/**
 * The per-machine escape hatch for a path a target pins: `ONESHOT_<TARGET>_<VAR>`.
 *
 * A target's paths are checked-in, so they are one machine's directory layout
 * committed to the repo. `ONESHOT_ERP_WORK_REPO` is how a checkout somewhere
 * other than `~/Documents/erp` says so without editing a tracked file — an edit
 * that would otherwise sit in `git status` forever, one `git commit -a` away
 * from repointing everybody else.
 *
 * A leading `ONESHOT_` is stripped before scoping so `ONESHOT_SEED_FROM` scopes
 * to `ONESHOT_ERP_SEED_FROM` rather than `ONESHOT_ERP_ONESHOT_SEED_FROM`.
 */
export function scopedEnvName(envName: string): string {
  const slug = PROJECT_TARGET.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  return `ONESHOT_${slug}_${envName.replace(/^ONESHOT_/, '')}`;
}

/**
 * A path a target owns: scoped env, then the target, then the plain env.
 *
 * The middle step is deliberately NOT `envOr` order. Everywhere else in this
 * file the environment wins, and there it must not: the switch exists so that
 * ONE line in .env moves the conductor to another project, and a machine that
 * has been working on the default has WORK_REPO and ONESHOT_SEED_FROM already
 * spelled out — leaving those in charge would make the switch look broken on
 * exactly the machines it is for.
 *
 * The scoped name sits ABOVE the target because it cannot be stale in the way
 * the plain one can: nothing sets `ONESHOT_ERP_WORK_REPO` except someone who
 * has already chosen the erp target and means that path for it. It buys back
 * the per-machine override without reopening the hole. `doctor` names every
 * variable in force, so neither step is silent.
 */
function targetPath(fromTarget: string | undefined, envName: string, fallback: string): string {
  if (PROJECT_TARGET) {
    const scoped = envOr(scopedEnvName(envName));
    if (scoped) return expandPath(scoped);
  }
  if (fromTarget) return expandPath(fromTarget);
  return expandPath(envOr(envName, fallback));
}

/** Env vars a selected target is overriding, for `doctor` to report. */
export function targetOverrides(): Array<{ name: string; ignored: string; using: string }> {
  const t = activeTarget();
  if (!t) return [];
  const pairs: Array<[string | undefined, string]> = [
    [t.workRepo, 'WORK_REPO'], [t.seedFrom, 'ONESHOT_SEED_FROM'], [t.wtRoot, 'WT_ROOT'],
  ];
  return pairs.flatMap(([value, name]) => {
    const set = envOr(name);
    if (!value || !set) return [];
    // What is actually in force, which is the scoped override when there is
    // one — reporting the target's pinned path there would name a directory
    // the conductor is not using.
    const using = targetPath(value, name, '');
    return expandPath(set) !== using ? [{ name, ignored: expandPath(set), using }] : [];
  });
}

let _project: ProjectConfig | null = null;
export function projectConfig(): ProjectConfig {
  if (!_project) {
    const c = loadJson<ProjectConfig>('project.json');
    const t = activeTarget();
    if (t) {
      if (t.gitlab?.project) c.gitlab.project = t.gitlab.project;
      if (typeof t.gitlab?.projectId === 'number') c.gitlab.projectId = t.gitlab.projectId;
      if (t.branches?.base) c.branches.base = t.branches.base;
      // Object.assign, so a target that names no label changes none, and a
      // label set to '' is the documented way to switch an optional one off.
      if (t.labels) Object.assign(c.labels, t.labels);
    }
    c.gitlab.apiUrl = envOr('ONESHOT_GITLAB_API', c.gitlab.apiUrl);
    c.gitlab.project = envOr('ONESHOT_GITLAB_PROJECT', c.gitlab.project);
    const idOverride = envOr('ONESHOT_PROJECT_ID');
    if (idOverride) c.gitlab.projectId = Number(idOverride);
    // Shared with the Plane triage router, so the gates and the routing can never disagree.
    const risk = loadJson<{ modules: Array<{ paths?: string[] }> }>('risk-modules.json');
    c.highScrutinyPaths = [...new Set([...(c.highScrutinyPaths ?? []), ...risk.modules.flatMap((m) => m.paths ?? [])])];
    _project = c;
  }
  return _project;
}

/** True unless config/project.json switches bug reproduction off. */
export function bugReproductionEnabled(): boolean {
  return projectConfig().bugReproduction !== false;
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

let _slack: SlackConfig | null = null;
export function slackConfig(): SlackConfig {
  if (!_slack) {
    const c = loadJson<SlackConfig>('slack.json');
    c.channel = envOr('ONESHOT_CHANNEL', c.channel);
    _slack = c;
  }
  return _slack;
}

/**
 * The two sign-off groups, by GitLab username (config/reviewers.json).
 *
 * Not merged into `slackConfig().allowlist`, which it replaces as the review
 * gates' authorisation source: that list holds SLACK user ids, and the gates
 * now read their verdict from GitLab ticket comments, where the only identity
 * on a note is a GitLab username. Keeping one list for both would mean an id
 * from one system silently failing to match a name from the other — the
 * failure mode being a gate that waits forever, which is indistinguishable
 * from a reviewer who has not looked yet.
 *
 * Unknown roles resolve to an empty list rather than throwing: `checkApprovalGate`
 * already treats empty as `unavailable` and blocks the run, which surfaces the
 * mistake to the person who can fix it instead of killing the conductor.
 */
export interface ReviewersConfig {
  dev: string[];
  qa: string[];
  /**
   * The work-email domain a GitLab username is completed with to find that
   * person's SLACK id (`<username>@<emailDomain>` → `users.lookupByEmail` →
   * `<@U…>`), so a gate's approval request can @mention the people it is
   * waiting on. See `mentionsFor` in src/conductor/reviewgate.ts.
   *
   * Derived rather than stored as a second list of ids on purpose: a mapping
   * table is a third place a roster can drift out of date, and it drifts
   * silently — the failure is a reviewer who stops being mentioned, which
   * looks exactly like a reviewer who has not replied yet. The cost of
   * deriving is that it assumes the convention holds; where it does not, that
   * one person resolves to nothing and `doctor` names them.
   *
   * Empty switches mentioning off without switching notification off: the
   * request still posts to the channel, unaddressed.
   */
  emailDomain: string;
  /**
   * GitLab username → pinned Slack member id, checked BEFORE any lookup.
   *
   * A gate's ask is posted exactly once, at the moment it arms. If the lookup
   * behind that one message is rate-limited the ask goes out unaddressed and
   * the reviewer never learns they are being waited on — so the mention that
   * matters most is the one least able to tolerate a network dependency. A
   * pinned id has none.
   *
   * Anyone absent here still resolves by handle, then by email, so adding a
   * reviewer needs no id — it just makes their first mention depend on
   * `users.list` answering. `doctor` cross-checks every pinned id against the
   * live workspace, because a WRONG id mentions the wrong person, which is
   * worse than mentioning nobody.
   */
  slackIds: Record<string, string>;
}

let _reviewers: ReviewersConfig | null = null;
export function reviewersConfig(): ReviewersConfig {
  if (!_reviewers) {
    const c = loadJson<Partial<ReviewersConfig>>('reviewers.json');
    _reviewers = {
      dev: Array.isArray(c.dev) ? c.dev : [],
      qa: Array.isArray(c.qa) ? c.qa : [],
      emailDomain: envOr('ONESHOT_REVIEWER_EMAIL_DOMAIN', typeof c.emailDomain === 'string' ? c.emailDomain : ''),
      slackIds: (c.slackIds && typeof c.slackIds === 'object') ? c.slackIds : {},
    };
  }
  return _reviewers;
}

let _mrFeedback: MrFeedbackConfig | null = null;
/** config/mr-feedback.json, validated. A missing file is the feature switched off. */
export function mrFeedbackConfig(): MrFeedbackConfig {
  if (!_mrFeedback) {
    const present = existsSync(join(ROOT, 'config', 'mr-feedback.json'));
    _mrFeedback = parseMrFeedbackConfig(present ? loadJson<unknown>('mr-feedback.json') : {}, reviewersConfig());
  }
  return _mrFeedback;
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
/**
 * The GitLab username this desk claims ASSIGNED tickets as.
 *
 * Not configuration. It is whoever this desk's GitLab token belongs to, resolved
 * once at boot by asking GitLab (src/lib/identity.ts), so the account that claims
 * a ticket is always the account that will comment, push and merge on it.
 *
 * Use gitlabUsername() rather than the const: the const is captured at module
 * load, which is before boot has asked.
 */
export const GITLAB_USERNAME = deskUsername();
export function gitlabUsername(): string { return deskUsername(); }

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
 * How often `--follow` re-checks a single ticket while it sits parked at a
 * Review gate, waiting for `approved` or feedback in the Slack thread.
 *
 * Deliberately slower than TICK_MS. A parked run re-enters the pipeline on
 * every tick, and any phase that has NOT recorded a success is re-attempted
 * from scratch each time — a `skip`-on-fail phase like `recall` re-runs a full
 * model lap per tick, which at 60s costs a lap a minute for as long as a human
 * takes to reply. Three minutes keeps a reply picked up promptly while cutting
 * that waste threefold. It never stops on its own: only `approved` or feedback
 * moves the run on.
 */
export const FOLLOW_TICK_MS = 180_000;

/**
 * How often the `merge` phase re-asks whether a human has merged a
 * Review-labelled ticket's MR. Merging and deploying such a ticket is a
 * person's decision end to end — Oneshot opens the MR and then only watches —
 * so this is a slow, patient poll rather than the tick loop's cadence.
 */
export const MERGE_POLL_MS = 1_800_000;

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
export const DB_PATH = join(STATE, 'oneshot.db');

export const WORK_REPO = targetPath(
  activeTarget()?.workRepo, 'WORK_REPO', '~/Documents/workstreamai',
);
export const CONTEXT_REPO = expandPath(envOr('CONTEXT_REPO', '~/Documents/erp'));
// Skills, agents and rules are vendored into this repo under `context/` (a
// committed snapshot of the ERP context repo's `.claude`, which also stays in
// GitLab), so the loop is self-contained: a fresh clone carries them and
// claudedir composes `.claude` from links that resolve without a local ERP
// checkout. Override with ONESHOT_SKILLS_ROOT to point at a live `.claude`
// (e.g. `~/Documents/erp/.claude`) when a machine's interactive edits should
// win over the vendored copy.
export const SKILLS_ROOT = expandPath(envOr('ONESHOT_SKILLS_ROOT', join(ROOT, 'context')));
export const WT_ROOT = targetPath(activeTarget()?.wtRoot, 'WT_ROOT', '~/Documents/oneshot-wt');

/**
 * The installed clone a leased worktree borrows node_modules, venv and
 * staticfiles from. Empty means seeding is switched off, which costs `npm ci`
 * minutes per worktree — so it stays a function with no default rather than
 * quietly becoming WORK_REPO.
 */
/**
 * Look for a checkout of `project` on this machine.
 *
 * Exists so a failure can name the path the person actually has instead of the
 * one they were told to type. Matched by REMOTE, not by directory name: a
 * folder called `erp` that points somewhere else is not the repo, and the
 * layouts people really use (~/Desktop/workstream-repo/erp) are not guessable
 * from the name alone. One level of nesting is searched, which covers every
 * layout seen so far without walking the whole home directory.
 */
export function findCheckout(project: string): string {
  const bases = ['Documents', 'Desktop', 'code', 'work', 'repos', 'projects', 'src', '']
    .map((b) => (b ? join(homedir(), b) : homedir()));
  const slug = project.split('/').pop() ?? project;

  const remoteMatches = (dir: string): boolean => {
    if (!existsSync(join(dir, '.git'))) return false;
    try {
      const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
      return url.includes(project);
    } catch { return false; }
  };

  for (const base of bases) {
    if (!existsSync(base)) continue;
    if (remoteMatches(join(base, slug))) return join(base, slug);
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const nested = join(base, entry, slug);
      if (remoteMatches(nested)) return nested;
    }
  }
  return '';
}

export function seedFrom(): string {
  return targetPath(activeTarget()?.seedFrom, 'ONESHOT_SEED_FROM', '');
}

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
