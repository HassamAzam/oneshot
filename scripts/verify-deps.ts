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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, envOr } from '../src/lib/config.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
let fails = 0;

function pass(l: string, d = ''): void { console.log(`  ${G}PASS${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function warn(l: string, d = ''): void { console.log(`  ${Y}WARN${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function fail(l: string, d = ''): void { fails += 1; console.log(`  ${R}FAIL${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }

/**
 * An MCP stdio server that started correctly stays alive waiting for input on
 * stdin. So "still running after N ms" is success, and an early exit — or a
 * hang with no process at all — is the failure.
 */
function probeStdioServer(
  cmd: string, args: string[], env: Record<string, string>, ms = 6000,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (d) => { stderr += String(d).slice(0, 400); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, detail: `spawn failed: ${err.message}` });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, detail: `exited early (code ${code}) ${stderr.trim().slice(0, 160)}` });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: true, detail: `alive after ${ms}ms` });
    }, ms);
  });
}

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

  const token = envOr('GITLAB_TOKEN');
  if (!token) {
    warn('GITLAB_TOKEN unset — probing without auth');
  }
  const probe = await probeStdioServer(cmd, args, {
    GITLAB_PERSONAL_ACCESS_TOKEN: token || 'probe',
    GITLAB_API_URL: envOr('ONESHOT_GITLAB_API', 'https://gitlab.arbisoft.com/api/v4'),
  });
  probe.ok
    ? pass('server starts', probe.detail)
    : fail('server does NOT start', probe.detail);

  console.log('\nClaude Code binary');
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  which.status === 0
    ? pass('on PATH', which.stdout.trim())
    : fail('not on PATH', 'the Agent SDK spawns it — every phase would fail');

  console.log('\nPlaywright browsers (phases 6-7, 11-12)');
  const pw = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
  if (pw.status === 0) {
    pass(pw.stdout.trim());
    const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
    existsSync(cache)
      ? pass('browser cache present', cache)
      : warn('no browser cache', 'run `npx playwright install chromium` with the VPN OFF');
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
