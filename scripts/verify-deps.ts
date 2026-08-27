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
import { BASE_ENV, ROOT, envOr } from '../src/lib/config.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
let fails = 0;

function pass(l: string, d = ''): void { console.log(`  ${G}PASS${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function warn(l: string, d = ''): void { console.log(`  ${Y}WARN${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }
function fail(l: string, d = ''): void { fails += 1; console.log(`  ${R}FAIL${X}  ${l}${d ? ` ${D}${d}${X}` : ''}`); }

/**
 * Spawn an MCP stdio server the way a PHASE spawns it, and make it prove
 * itself by listing tools.
 *
 * Two things here were learned the hard way. The env is passed WHOLE rather
 * than merged over process.env, because that is the SDK's semantics and the
 * merge is what made this check lie: a server missing PATH dies with
 * `env: node: No such file or directory` inside a phase while passing here.
 * And "alive after N ms" is not the bar — the failure that actually happened
 * was a server the SDK reported as `connected` that served ZERO tools, so the
 * handshake and a non-empty tools/list are the only evidence worth anything.
 */
function probeStdioServer(
  cmd: string, args: string[], env: Record<string, string>, ms = 6000,
): Promise<{ ok: boolean; detail: string; tools: number }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let stdout = '';
    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const done = (r: { ok: boolean; detail: string; tools: number }): void => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };

    child.stdout?.on('data', (d) => { stdout += String(d); });

    const send = (o: unknown): void => {
      try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* exit handler reports */ }
    };
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'oneshot-doctor', version: '1' },
      },
    });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 1200);
    setTimeout(() => {
      const tools = stdout.split('\n').filter(Boolean).reduce((n, line) => {
        try {
          const m = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
          return m.id === 2 ? (m.result?.tools ?? []).length : n;
        } catch { return n; }
      }, 0);
      done(tools > 0
        ? { ok: true, detail: `${tools} tools`, tools }
        : {
          ok: false, tools: 0,
          detail: `handshake produced NO tools — a session would see the server as connected ` +
            `and hold none of its tools. ${stderr.trim().slice(0, 160)}`,
        });
    }, ms);

    child.stderr?.on('data', (d) => { stderr += String(d).slice(0, 400); });

    child.on('error', (err) => {
      done({ ok: false, tools: 0, detail: `spawn failed: ${err.message}` });
    });

    child.on('exit', (code) => {
      done({
        ok: false, tools: 0,
        detail: `exited early (code ${code}) ${stderr.trim().slice(0, 160)}`,
      });
    });
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
  // The SAME env object a phase hands the SDK — whole, not merged over
  // process.env. Merging is what let a server with no PATH pass this check and
  // then die inside every phase.
  const probe = await probeStdioServer(cmd, args, {
    ...BASE_ENV,
    GITLAB_PERSONAL_ACCESS_TOKEN: token || 'probe',
    GITLAB_API_URL: envOr('ONESHOT_GITLAB_API', 'https://gitlab.arbisoft.com/api/v4'),
    USE_PIPELINE: 'true',
    USE_GITLAB_WIKI: 'false',
    USE_MILESTONE: 'false',
  });
  probe.ok
    ? pass('server serves tools', probe.detail)
    : fail('server serves NO tools', probe.detail);

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
