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
  CONTEXT_REPO, SKILLS_ROOT, WORK_REPO, WT_ROOT,
  auditAuth, budgetConfig, envOr, expandPath, phases, portPool,
  projectConfig, reviewersConfig, slackConfig,
} from '../src/lib/config.js';
import { ping, listBranches } from '../src/lib/gitlab.js';
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
  const cfg = projectConfig();
  pass('project.json', `${cfg.gitlab.project} (id ${cfg.gitlab.projectId})`);
  pass('labels', `"${cfg.labels.entry}" -> "${cfg.labels.exit}", blocked "${cfg.labels.blocked}", ` +
    `optional review gate "${cfg.labels.review}" (off unless a ticket carries it too)`);

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
  // The env var is printed with the failure because it is not always the
  // label: SKILLS_ROOT is overridden by ONESHOT_SKILLS_ROOT. Reporting the
  // path alone leaves the reader guessing which knob moves it, and the
  // defaults below are one machine's layout, so a fresh clone hits all three.
  for (const [label, p, required, envVar] of [
    ['WORK_REPO', WORK_REPO, true, 'WORK_REPO'],
    ['CONTEXT_REPO', CONTEXT_REPO, false, 'CONTEXT_REPO'],
    ['SKILLS_ROOT', SKILLS_ROOT, false, 'ONESHOT_SKILLS_ROOT'],
  ] as Array<[string, string, boolean, string]>) {
    if (existsSync(p)) pass(label, p);
    else if (required) fail(label, `${p} does not exist — set ${envVar}`);
    else warn(label, `${p} does not exist — set ${envVar}`);
  }

  if (existsSync(WORK_REPO)) {
    const git = spawnSync('git', ['-C', WORK_REPO, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const url = git.stdout.trim();
    if (url.includes(cfg.gitlab.project)) pass('WORK_REPO origin', url);
    else fail('WORK_REPO origin mismatch', `${url} is not ${cfg.gitlab.project}`);
  }

  if (existsSync(SKILLS_ROOT)) {
    const skillsDir = join(SKILLS_ROOT, 'skills');
    if (existsSync(skillsDir)) {
      const n = spawnSync('sh', ['-c', `ls -1 "${skillsDir}" | wc -l`], { encoding: 'utf8' });
      pass('skills discovered', `${n.stdout.trim()} in ${skillsDir}`);
    } else warn('no skills/ under SKILLS_ROOT', skillsDir);
  }

  if (existsSync(WT_ROOT)) {
    if (statSync(WT_ROOT).isDirectory()) pass('WT_ROOT', WT_ROOT);
  } else warn('WT_ROOT will be created on first run', WT_ROOT);

  // The seed repo is read when a worktree is leased, not at boot, so an absent
  // one is silent until phase 3 and only *hurts* at phase 6, where `verify`
  // needs a runnable app. That is exactly the "confusing failure three phases
  // in" this script exists to pull forward.
  const seedFrom = expandPath(envOr('ONESHOT_SEED_FROM', ''));
  if (!seedFrom) {
    warn('no seed repo configured', 'set ONESHOT_SEED_FROM — without it a leased worktree has '
      + 'no node_modules/venv, so `verify` cannot run the app');
  } else if (!existsSync(seedFrom)) {
    warn('seed repo does not exist', `${seedFrom} — set ONESHOT_SEED_FROM to a repo that is `
      + 'already installed (node_modules, venv)');
  } else {
    const links = envOr('ONESHOT_SEED_LINKS', '').split(',').map((s) => s.trim()).filter(Boolean);
    const copies = envOr('ONESHOT_SEED_COPIES', '').split(',').map((s) => s.trim()).filter(Boolean);
    const missing = [...links, ...copies].filter((rel) => !existsSync(join(seedFrom, rel)));
    if (missing.length) warn('seed entries missing from the seed repo', missing.join(', '));
    else pass('seed repo', `${seedFrom} (${links.length} linked, ${copies.length} copied)`);
  }

  const ports = portPool();
  if (ports.length) pass('port pool', ports.join(', '));
  else fail('port pool is empty', 'phases needing a dev server cannot run');

  // --------------------------------------------------------------- gitlab
  section('GitLab');
  if (!envOr('GITLAB_TOKEN')) {
    fail('GITLAB_TOKEN unset', 'cp .env.example .env and fill it in');
  } else {
    const p = await ping();
    if (p.ok) {
      pass('reachable + authenticated', `project id ${p.data?.id}`);

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
      const br = await listBranches();
      if (br.ok && br.data) {
        const names = new Set(br.data.map((x) => x.name));
        if (names.has(cfg.branches.base)) pass('base branch exists', cfg.branches.base);
        else fail('base branch missing', cfg.branches.base);

        for (const prot of cfg.branches.protected) {
          const found = br.data.find((x) => x.name === prot);
          if (!found) { warn(`protected branch '${prot}' not found`, 'listed in config but absent'); continue; }
          if (!found.protected) fail(`'${prot}' is NOT protected on GitLab`, 'server-side protection is the real guarantee');
          else pass(`'${prot}' protected`);
        }
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
