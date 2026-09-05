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
  auditAuth, budgetConfig, deployConfig, envOr, phases, portPool,
  projectConfig, slackConfig,
} from '../src/lib/config.js';
import { ping, listBranches } from '../src/lib/gitlab.js';
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

  // The branch-TIP deploy still means only ONE run may hold the merge→deploy→qa
  // window, but that is now enforced by the in-process promotion mutex rather
  // than by pinning the whole pipeline to a single ticket. A sane upper bound
  // is the port pool — every server-holding phase needs its own port.
  if (cfg.concurrency < 1 || cfg.concurrency > portPool().length) {
    fail('concurrency out of range',
      `must be 1..${portPool().length} (the port pool); the promotion mutex, not this number, ` +
      'keeps QA verdicts attributable');
  } else {
    pass('concurrency', `${cfg.concurrency} — merge→qa serialized by the promotion mutex, ` +
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
  for (const [label, p, required] of [
    ['WORK_REPO', WORK_REPO, true],
    ['CONTEXT_REPO', CONTEXT_REPO, false],
    ['SKILLS_ROOT', SKILLS_ROOT, false],
  ] as Array<[string, string, boolean]>) {
    if (existsSync(p)) pass(label, p);
    else if (required) fail(label, `${p} does not exist`);
    else warn(label, `${p} does not exist`);
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
  const guards = ['pause-check', 'write-scope', 'git-guard', 'deploy-guard', 'budget-gate', 'log-event', '_common'];
  const missing = guards.filter((g) => !existsSync(join(process.cwd(), 'hooks', `${g}.cjs`)));
  missing.length
    ? fail('guard scripts missing', missing.join(', '))
    : pass(`${guards.length} guard scripts present`, 'loaded in-process, no install step');

  const verify = spawnSync('bash', ['scripts/verify-hooks.sh'], { encoding: 'utf8' });
  if (verify.status === 0) {
    const last = verify.stdout.trim().split('\n').pop() ?? '';
    pass('guard test suite', last.replace(/\x1b\[[0-9;]*m/g, ''));
  } else {
    fail('guard test suite failed', 'run: npm run hooks:verify');
  }

  // --------------------------------------------------------------- deploy
  section('Deploy (phase 10)');
  const d = deployConfig();
  if (existsSync(join(process.cwd(), d.script))) pass('deploy script vendored', d.script);
  else warn('deploy script missing', `${d.script} — phase 10 will report BLOCKED`);
  pass('demo target', d.demoUrl);
  if (d.vpnGated) warn('demo host is VPN-gated', `${d.server} — phase 10 probes it before deploying`);

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
  warn('Review-label gates need channels:history/groups:history on the bot token',
    'chat:write (posting) does not cover reading a reply back — see config/slack.json\'s ' +
    '_comment_history and README\'s "Optional human review gates"');

  // -------------------------------------------------------------- verdict
  console.log(`\n${fails ? R : G}${fails} failed${X}, ${Y}${warns} warnings${X}\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}doctor crashed${X}: ${(err as Error).message}\n`);
  process.exit(1);
});
