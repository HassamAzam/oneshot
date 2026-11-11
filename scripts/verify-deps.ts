/**
 * `npm run deps:verify` — prove every out-of-process dependency actually starts.
 *
 * This exists because of a real failure: `doctor` reported 0 failed while the
 * GitLab MCP server could not start at all. It was configured as `npx -y
 * @zereight/mcp-gitlab`, npx re-resolves against the npm registry on every
 * spawn, and this machine's npm traffic is blocked whenever the FortiClient VPN
 * is up — the same VPN GitLab itself requires. The phase then sat with no tools
 * and burned its whole wall-clock timeout at ZERO turns.
 *
 * The lesson generalises: checking that a dependency is CONFIGURED is not the
 * same as checking that it RUNS. Everything here is spawned for real.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_ENV, ROOT, envOr, repoIdentity } from '../src/lib/config.js';
import { playwrightCaches } from '../src/lib/appenv.cjs';
import { probeStdioServer } from '../src/lib/mcpprobe.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
let fails = 0;

function pass(l: string, d = ''): void { console.log(`  ${G}PASS${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function warn(l: string, d = ''): void { console.log(`  ${Y}WARN${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function fail(l: string, d = ''): void { fails += 1; console.log(`  ${R}FAIL${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }

async function main(): Promise<void> {
  console.log('\nOneshot dependency probe');

  console.log('\nNode packages');
  for (const pkg of ['@anthropic-ai/claude-agent-sdk', '@zereight/mcp-gitlab', 'better-sqlite3', 'playwright']) {
    existsSync(join(ROOT, 'node_modules', pkg))
      ? pass(pkg)
      : fail(pkg, 'not installed — run npm install with the VPN OFF');
  }

  console.log('\nGitLab MCP server (spawned for real)');
  const local = join(ROOT, 'node_modules', '.bin', 'mcp-gitlab');
  const cmd = envOr('GITLAB_MCP_CMD', existsSync(local) ? local : 'npx');
  const args = envOr('GITLAB_MCP_ARGS', cmd === 'npx' ? '-y @zereight/mcp-gitlab' : '')
    .split(' ').filter(Boolean);

  if (cmd === 'npx') {
    fail('configured as `npx`',
      'npx hits the npm registry on every spawn and hangs behind the VPN. ' +
      'Install the package locally so node_modules/.bin/mcp-gitlab is used.');
  } else {
    pass('resolved to a local binary', cmd.replace(ROOT, '.'));
  }

  // The token a phase hands the server (src/conductor/phase.ts, mcpServers).
  const token = envOr('ONESHOT_GITLAB_TOKEN') || envOr('GITLAB_TOKEN');
  if (!token) {
    warn('no GitLab token (ONESHOT_GITLAB_TOKEN or GITLAB_TOKEN) — probing without auth');
  }
  // The same API root a phase hands the server (src/conductor/phase.ts). With
  // GITLAB_REPO_URL unusable there is none to give; listing tools needs no API
  // call, so the probe still runs and the URL is failed on its own line.
  const { repo, error } = repoIdentity();
  if (!repo) fail('GITLAB_REPO_URL', error ?? 'unset');
  // The SAME env object a phase hands the SDK — whole, not merged over
  // process.env. Merging is what let a server with no PATH pass this check and
  // then die inside every phase.
  const probe = await probeStdioServer(cmd, args, {
    ...BASE_ENV,
    GITLAB_PERSONAL_ACCESS_TOKEN: token || 'probe',
    ...(repo ? { GITLAB_API_URL: repo.apiUrl } : {}),
    USE_PIPELINE: 'true',
    USE_GITLAB_WIKI: 'false',
    USE_MILESTONE: 'false',
  });
  // "Lists some tools" is not the bar: the CLI rejects the whole list over one
  // tool it cannot accept, and this check passed on 69 unusable tools while every
  // session ran without GitLab (src/lib/mcpprobe.ts).
  probe.ok
    ? pass('server serves tools a session accepts', `${probe.detail}${probe.tookMs === null ? '' : ` in ${probe.tookMs}ms`}`)
    : fail('server serves NO usable tools', probe.detail);

  console.log('\nClaude Code binary');
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  which.status === 0
    ? pass('on PATH', which.stdout.trim())
    : fail('not on PATH', 'the Agent SDK spawns it — every phase would fail');

  console.log('\nPlaywright browsers (phases 6-7, 11-12)');
  const pw = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
  if (pw.status === 0) {
    pass(pw.stdout.trim());
    const [cache = ''] = playwrightCaches();
    const hint = process.platform === 'linux'
      ? 'run `sudo npx playwright install-deps chromium && npx playwright install chromium`'
      : 'run `npx playwright install chromium` with the VPN OFF';
    existsSync(cache)
      ? pass('browser cache present', cache)
      : warn('no browser cache', `${cache} is missing — ${hint}`);
  } else {
    warn('playwright not runnable', 'only needed from M3 onward');
  }

  console.log(`\n${fails ? R : G}${fails} failed${X}\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nprobe crashed: ${(err as Error).message}\n`);
  process.exit(1);
});
