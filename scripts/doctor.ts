/**
 * `npm run doctor` — everything that must be true before a real ticket runs.
 *
 * Checks are ordered cheapest-first and each is independent, so a failure
 * early does not hide the rest. Exit 1 on any FAIL; WARN never fails the run.
 */
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  CONTEXT_REPO, PROJECT_TARGET, SKILLS_ROOT, WORK_REPO, WT_ROOT, pathSources, seedFrom,
  auditAuth, budgetConfig, bugReproductionEnabled, envOr, expandPath, phases, portPool,
  projectConfig, repoIdentity, reviewersConfig, slackConfig,
} from '../src/lib/config.js';
import { ping, getBranch } from '../src/lib/gitlab.js';
import {
  checkoutFindings, identityFindings, relaxRepoChecks, repoCheckOverrideNotice, wtRootFinding, type Finding,
} from '../src/lib/repocheck.js';
import { foreignJournalFinding } from '../src/lib/journalproject.js';
import { slackEnabled, userIdForEmail, userIdForHandle } from '../src/lib/slack.js';
import { checkIdentity } from '../src/lib/identity.js';
import { otelStatus, promptTextExported } from '../src/lib/otel.js';

let fails = 0;
let warns = 0;

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${G}PASS${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warns += 1;
  console.log(`  ${Y}WARN${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function fail(label: string, detail = ''): void {
  fails += 1;
  console.log(`  ${R}FAIL${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function section(name: string): void { console.log(`\n${name}`); }
function report(f: Finding): void {
  if (f.level === 'fail') fail(f.label, f.detail);
  else if (f.level === 'warn') warn(f.label, f.detail);
  else pass(f.label, f.detail);
}

async function main(): Promise<void> {
  console.log('\nOneshot doctor');

  // ------------------------------------------------------------------ auth
  section('Claude auth');
  const auth = auditAuth();
  if (auth.clean) {
    pass('no metered-billing credential in the environment', auth.credential);
  } else {
    for (const p of auth.problems) fail('auth', p);
  }
  for (const n of auth.notes) warn('auth', n);
  const claude = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claude.status === 0) pass('claude CLI on PATH', claude.stdout.trim());
  else warn('claude CLI not on PATH', 'the Agent SDK spawns it — sessions will fail');

  // --------------------------------------------------------------- config
  section('Config');
  // Which project, first: every check below is about it. GITLAB_REPO_URL is the
  // only thing that says; any legacy selector still in .env is judged against it.
  // ONESHOT_SKIP_REPO_CHECK turns every repo-check FAIL below into a WARN;
  // said on every run, so the override cannot quietly outlive the problem.
  const override = repoCheckOverrideNotice();
  if (override) warn('repo checks overridden', override);
  for (const f of relaxRepoChecks(identityFindings())) report(f);
  const repo = repoIdentity().repo;
  const cfg = projectConfig();
  pass('labels', `"${cfg.labels.entry}" -> "${cfg.labels.exit}", blocked "${cfg.labels.blocked}", ` +
    (cfg.labels.review
      ? `optional review gate "${cfg.labels.review}" (off unless a ticket carries it too)`
      : 'review label: off (labels.review empty)'));
  if (cfg.labels.testcaseReview) {
    pass('board label', `"${cfg.labels.testcaseReview}" — on while a ticket sits at the testcases QA gate`);
  }
  if (bugReproductionEnabled()) {
    if (cfg.labels.notABug) {
      pass('bug reproduction', `on — a bug research cannot reproduce parks for QA, and stops as "${cfg.labels.notABug}" once they approve ` +
        '(the label must exist on the project)');
    } else {
      warn('bug reproduction without a label',
        'labels.notABug is unset — a run that cannot reproduce its bug still stops and says so, but the ticket gets no label');
    }
  } else {
    pass('bug reproduction', 'off (bugReproduction: false)');
  }

  // Only ONE run may hold the promotion window at a time, enforced by the
  // in-process mutex rather than by pinning the whole pipeline to a single
  // ticket. A sane upper bound is the port pool — every server-holding phase
  // needs its own port.
  if (cfg.concurrency < 1 || cfg.concurrency > portPool().length) {
    fail('concurrency out of range',
      `must be 1..${portPool().length} (the port pool); the promotion mutex, not this number, ` +
      'keeps concurrent merges off each other');
  } else {
    pass('concurrency', `${cfg.concurrency} — merges serialized by the promotion mutex, ` +
      `capped at the ${portPool().length}-port pool`);
  }

  const ph = phases();
  const codePhases = ph.filter((p) => p.kind === 'code').map((p) => p.name);
  pass(`${ph.length} phases`, `deterministic: ${codePhases.join(', ')}`);
  const missingTier = ph.filter((p) => p.kind === 'session' && !p.tier);
  if (missingTier.length) fail('phases without a tier', missingTier.map((p) => p.name).join(', '));

  const b = budgetConfig();
  const phaseSum = Object.values(b.phases).reduce((a, n) => a + n, 0);
  if (phaseSum > b.ticket_tokens) {
    warn('phase ceilings exceed the per-ticket ceiling',
      `${phaseSum} > ${b.ticket_tokens} — the ticket cap binds first`);
  } else {
    pass('budgets', `${(b.ticket_tokens / 1e6).toFixed(1)}M weighted/ticket, ${(b.window_tokens / 1e6).toFixed(0)}M/window`);
  }

  // ---------------------------------------------------------------- paths
  section('Paths');
  // Each path says which variable put it there. A plain WORK_REPO beats the
  // default derived from GITLAB_REPO_URL, and the scoped ONESHOT_<NAME>_<VAR>
  // beats both, so a surprising directory below is only fixable if the line
  // that chose it is named. The env var is printed with a failure for the same
  // reason: SKILLS_ROOT is moved by ONESHOT_SKILLS_ROOT, not by its own name.
  const sources = pathSources();
  const origin = (name: keyof typeof sources): string => {
    const src = sources[name];
    if (src.source === 'scoped') return `from ${src.key} — the per-project spelling, still honoured`;
    if (src.source === 'plain') return `from ${src.key}`;
    return 'default derived from GITLAB_REPO_URL';
  };
  for (const [label, p, required, envVar, from] of [
    ['WORK_REPO', WORK_REPO, true, 'WORK_REPO', origin('WORK_REPO')],
    ['CONTEXT_REPO', CONTEXT_REPO, false, 'CONTEXT_REPO', ''],
    ['SKILLS_ROOT', SKILLS_ROOT, false, 'ONESHOT_SKILLS_ROOT', ''],
  ] as Array<[string, string, boolean, string, string]>) {
    if (!p) fail(label, `no path — set GITLAB_REPO_URL (default ~/Documents/<name>) or ${envVar}`);
    else if (existsSync(p)) pass(label, from ? `${p} (${from})` : p);
    else if (required) fail(label, `${p} does not exist — clone the project there, or set ${envVar}`);
    else warn(label, `${p} does not exist — set ${envVar}`);
  }

  if (existsSync(SKILLS_ROOT)) {
    const skillsDir = join(SKILLS_ROOT, 'skills');
    if (existsSync(skillsDir)) {
      const n = spawnSync('sh', ['-c', `ls -1 "${skillsDir}" | wc -l`], { encoding: 'utf8' });
      pass('skills discovered', `${n.stdout.trim()} in ${skillsDir}`);
    } else warn('no skills/ under SKILLS_ROOT', skillsDir);
  }

  if (!WT_ROOT) fail('WT_ROOT', 'no path — set GITLAB_REPO_URL (default ~/Documents/<name>-wt) or WT_ROOT');
  else if (existsSync(WT_ROOT)) {
    if (statSync(WT_ROOT).isDirectory()) pass('WT_ROOT', `${WT_ROOT} (${origin('WT_ROOT')})`);
  } else warn('WT_ROOT will be created on first run', `${WT_ROOT} (${origin('WT_ROOT')})`);
  // A plain WT_ROOT beats the derived default, so a line left over from another
  // project wins and nothing else would notice. Judged only against a project:
  // with GITLAB_REPO_URL unusable (Config says so) there is none to compare with.
  const shared = repo ? wtRootFinding(WT_ROOT, sources.WT_ROOT, PROJECT_TARGET) : null;
  if (shared) for (const f of relaxRepoChecks([shared])) report(f);

  // The seed repo is read when a worktree is leased, not at boot, so an absent
  // one is silent until phase 3 and only *hurts* at phase 6, where `verify`
  // needs a runnable app. That is exactly the "confusing failure three phases
  // in" this script exists to pull forward.
  const seed = seedFrom();
  if (!seed) {
    warn('no seed repo configured', 'set ONESHOT_SEED_FROM — without it a leased worktree has '
      + 'no node_modules/venv, so `verify` cannot run the app');
  } else if (!existsSync(seed)) {
    warn('seed repo does not exist', `${seed} — set ONESHOT_SEED_FROM to a repo that is `
      + 'already installed (node_modules, venv)');
  } else {
    const links = envOr('ONESHOT_SEED_LINKS', '').split(',').map((s) => s.trim()).filter(Boolean);
    const copies = envOr('ONESHOT_SEED_COPIES', '').split(',').map((s) => s.trim()).filter(Boolean);
    const missing = [...links, ...copies].filter((rel) => !existsSync(join(seed, rel)));
    if (missing.length) warn('seed entries missing from the seed repo', missing.join(', '));
    else pass('seed repo', `${seed} (${links.length} linked, ${copies.length} copied; ${origin('ONESHOT_SEED_FROM')})`);
  }

  // A clone of some other project would cut every worktree from the wrong code
  // while tickets and MRs went to the right one — and the seed is not only
  // borrowed from: scripts/app.cjs fetches MR refs in it and cuts app worktrees
  // from it. A different project path fails and the same path on another host
  // only warns, so an ssh origin matches an https URL and erp never matches
  // erp-archive. The same call boot and preflight make.
  if (repo) {
    for (const f of relaxRepoChecks(checkoutFindings({ workRepo: WORK_REPO, seed, sources }))) report(f);
    // Journals are keyed by iid alone, so another project's are never resumed;
    // they are still worth knowing about.
    const foreignRuns = foreignJournalFinding();
    if (foreignRuns) report(foreignRuns);
  } else {
    warn('checkouts not checked', 'there is no project to compare WORK_REPO, the seed, WT_ROOT or the run '
      + 'journals with until GITLAB_REPO_URL is fixed (see Config)');
  }

  const ports = portPool();
  if (ports.length) pass('port pool', ports.join(', '));
  else fail('port pool is empty', 'phases needing a dev server cannot run');

  // --------------------------------------------------------------- gitlab
  section('GitLab');
  if (!envOr('GITLAB_TOKEN')) {
    fail('GITLAB_TOKEN unset', 'cp .env.example .env and fill it in');
  } else if (!repo) {
    warn('GitLab not checked', 'there is no project to ask about until GITLAB_REPO_URL is fixed (see Config)');
  } else {
    const p = await ping();
    if (p.ok) {
      pass('reachable + authenticated', `${repo.project}, project id ${p.data?.id}`);

      // Who is this desk? The token answers, and the token also does the work,
      // so there is no second fact that can disagree with it.
      const idc = await checkIdentity();
      if (!idc.token) {
        fail('this desk has no usable GitLab token', 'every ASSIGNED ticket is skipped — run `npm run token:set`');
      } else if (idc.token.source.shared && idc.claudeUsername !== idc.token.username && !idc.token.bot) {
        fail(`acting as ${idc.token.username}, but this desk is signed in as ${idc.claudeUsername ?? 'nobody'}`,
          'that is somebody else\'s credential doing your work — run `npm run token:set`');
      } else if (idc.token.source.shared) {
        pass('acts as itself', `${idc.token.username}, token from .env`);
        warn('token lives in .env', '.env has leaked into a run transcript before — `npm run token:set` moves it outside the repo');
      } else if (idc.token.bot) {
        pass('acts as a bot', `${idc.token.username} — cannot be mistaken for a reviewer`);
      } else {
        pass('acts as itself', `${idc.token.username}, token from ${idc.token.source.source}`);
      }
      if (idc.warning && !idc.token?.source.shared) warn('identity', idc.warning.split('\n')[0] ?? '');
      // Each branch is fetched by name. Listing them returns one page of 100,
      // and a project with more branches than that hides `dev` off the page.
      const wanted = [...new Set([cfg.branches.base, ...cfg.branches.protected])];
      const branch = new Map(await Promise.all(wanted.map(async (n) => [n, await getBranch(n)] as const)));
      const base = branch.get(cfg.branches.base);
      if (base?.ok && base.data) pass('base branch exists', cfg.branches.base);
      else if (base?.status === 404) fail('base branch missing', cfg.branches.base);
      else warn('base branch not checked', base?.error ?? `HTTP ${base?.status ?? '?'}`);

      for (const prot of cfg.branches.protected) {
        const found = branch.get(prot);
        if (found?.status === 404) { warn(`protected branch '${prot}' not found`, 'listed in config but absent'); continue; }
        if (!found?.ok || !found.data) { warn(`protected branch '${prot}' not checked`, found?.error ?? `HTTP ${found?.status ?? '?'}`); continue; }
        if (!found.data.protected) fail(`'${prot}' is NOT protected on GitLab`, 'server-side protection is the real guarantee');
        else pass(`'${prot}' protected`);
      }
    } else if (p.kind === 'auth') {
      fail('GitLab refused the token', `HTTP ${p.status} — needs scope 'api'`);
    } else if (p.kind === 'network') {
      fail('GitLab unreachable', 'VPN down? that subnet is FortiClient-gated');
    } else {
      fail('GitLab error', `${p.kind} HTTP ${p.status}`);
    }
  }

  // ---------------------------------------------------------------- hooks
  section('Guardrails');
  // Guards are passed to the SDK in-process (src/conductor/hooks.ts), so there
  // is nothing to install and nothing in settings.json to check. What matters
  // is that the .cjs files exist and still enforce what they claim to.
  const guards = ['pause-check', 'write-scope', 'git-guard', 'budget-gate', 'log-event', '_common'];
  const missing = guards.filter((g) => !existsSync(join(process.cwd(), 'hooks', `${g}.cjs`)));
  missing.length
    ? fail('guard scripts missing', missing.join(', '))
    : pass(`${guards.length} guard scripts present`, 'loaded in-process, no install step');

  const verify = spawnSync('bash', ['scripts/verify-hooks.sh'], { encoding: 'utf8' });
  if (verify.status === 0) {
    const last = verify.stdout.trim().split('\n').pop() ?? '';
    pass('guard test suite', last.replace(/\x1b\[[0-9;]*m/g, ''));
  } else {
    fail('guard test suite failed',
      'run: npm run hooks:verify — note an absent SKILLS_ROOT fails its symlink test on its '
      + 'own, so this and the path check above are usually one cause, not two');
  }

  // ------------------------------------------------------------ telemetry
  section('Session tracking (Langfuse)');
  const otel = otelStatus();
  if (!otel.on) {
    warn('telemetry OFF', otel.why);
  } else {
    if (otel.remote) warn('telemetry ON, endpoint is remote', otel.why);
    else pass('telemetry ON', otel.why);

    if (otel.why.includes('+responses')) {
      pass('assistant responses saved', '~0.5-1.5 MB/ticket — output only, never replayed');
    }
    if (promptTextExported()) {
      fail('prompt TEXT export is enabled',
        'prompts replay the whole conversation every turn: ~30-60 MB/ticket, and a full ' +
        'unredacted copy of every ticket body and diff. Set logUserPrompts:false.');
    }
  }

  // ---------------------------------------------------------------- slack
  section('Slack');
  if (!envOr('SLACK_BOT_TOKEN')) warn('SLACK_BOT_TOKEN unset', 'status stays on the console');
  else pass('bot token present');
  if (!slackConfig().channel) warn('no channel configured', 'set ONESHOT_CHANNEL or config/slack.json');
  else pass('channel', slackConfig().channel);
  if (!slackConfig().allowlist.length) warn('command allowlist is empty', 'every Slack command will be refused');
  // Only where the gates could actually run: an install with no Slack, or no
  // Review label configured, cannot hit this and does not need a standing
  // warning telling it so on every doctor run.
  //
  // There is deliberately NO check here for channels:history/groups:history.
  // An earlier version of the gates read their verdict out of the ticket's
  // Slack thread and this block FAILED without that scope; they read GitLab
  // now (src/conductor/reviewgate.ts), so the scope is dead and demanding it
  // sent people to the Slack console to fix a non-problem. See
  // config/slack.json's _comment_history.
  const allRuns = cfg.reviewAllRuns === true;
  if (slackEnabled() && (cfg.labels.review || allRuns)) {
    // The gates @mention the owning group when they arm. Resolve every name
    // for real rather than checking that config looks plausible: an
    // unresolvable reviewer fails silently — the ask posts unaddressed and
    // they never learn they are being waited on.
    const { dev, qa, emailDomain, slackIds } = reviewersConfig();
    const names = [...new Set([...dev, ...qa])];
    if (names.length) {
      // A pinned id is trusted at runtime without a lookup, so this is the
      // only place it is ever checked. Verify it against the live workspace
      // rather than merely that it is present: a stale or mistyped id does
      // not fail loudly, it @mentions somebody else, and the run still waits
      // on a person who was never asked.
      const wrong: string[] = [];
      for (const [u, id] of Object.entries(slackIds)) {
        const live = await userIdForHandle(u);
        if (live && live !== id) wrong.push(`${u} pinned ${id} but @${u} is ${live}`);
      }
      if (wrong.length) {
        fail('a pinned Slack id does not match that person',
          `${wrong.join('; ')} — config/reviewers.json would @mention the wrong person`);
      } else if (Object.keys(slackIds).length) {
        pass('pinned Slack ids agree with the workspace', `${Object.keys(slackIds).length} checked`);
      }

      const resolved = await Promise.all(names.map(async (u) => {
        if (slackIds[u]) return [u, 'pinned'] as const;
        if (await userIdForHandle(u)) return [u, 'handle'] as const;
        if (emailDomain && await userIdForEmail(`${u}@${emailDomain}`)) return [u, 'email'] as const;
        return [u, null] as const;
      }));
      const missing = resolved.filter(([, via]) => !via).map(([u]) => u);
      const viaPinned = resolved.filter(([, via]) => via === 'pinned').length;
      if (!missing.length) {
        pass('reviewer Slack mentions', `${names.length} resolved (${viaPinned} pinned)`);
      } else if (missing.length === names.length) {
        warn('no reviewer resolves to a Slack id',
          'the bot token needs users:read (handle lookup) or users:read.email. Approval '
          + 'requests still post to the channel, unaddressed.');
      } else {
        warn(`reviewers not reachable on Slack: ${missing.join(', ')}`,
          'no workspace account whose handle matches the GitLab username'
          + (emailDomain ? `, and no <name>@${emailDomain}` : '')
          + ' — they will not be @mentioned when a gate waits on them');
      }
    }
  }

  // -------------------------------------------------------------- verdict
  console.log(`\n${fails ? R : G}${fails} failed${X}, ${Y}${warns} warnings${X}\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}doctor crashed${X}: ${(err as Error).message}\n`);
  process.exit(1);
});
