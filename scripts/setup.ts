/**
 * `npm run setup` — interactive first-run wizard.
 *
 * `npm start` calls this automatically when there is no .env, so a fresh clone
 * is `npm install && npm start` and nothing else. Every prompt has a working
 * default; pressing Enter through the whole thing produces a valid config for
 * this machine.
 *
 * Secrets are written to .env at mode 600 and never echoed back.
 */
import { createInterface } from 'node:readline/promises';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(label: string, opts: { default?: string; secret?: boolean; hint?: string } = {}) {
  const def = opts.default ? ` ${D}[${opts.secret ? '••••' : opts.default}]${X}` : '';
  if (opts.hint) console.log(`  ${D}${opts.hint}${X}`);
  const answer = (await rl.question(`  ${label}${def}: `)).trim();
  return answer || opts.default || '';
}

function setKey(body: string, key: string, value: string): string {
  if (!value) return body;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(body) ? body.replace(re, `${key}=${value}`) : `${body}\n${key}=${value}`;
}

/** Reuse a credential the machine already has rather than making them paste it again. */
function existingGitlabToken(): string {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as Record<string, any>;
    const t = d?.mcpServers?.gitlab?.env?.GITLAB_PERSONAL_ACCESS_TOKEN;
    return typeof t === 'string' ? t : '';
  } catch { return ''; }
}

function detectRepo(name: string): string {
  for (const base of [join(homedir(), 'Documents'), homedir()]) {
    const p = join(base, name);
    if (existsSync(join(p, '.git'))) return p;
  }
  return '';
}

async function main(): Promise<void> {
  console.log(`\n${B}Oneshot setup${X}\n`);

  if (existsSync(ENV)) {
    const overwrite = await ask('.env already exists. Reconfigure it? (y/N)', { default: 'N' });
    if (!/^y/i.test(overwrite)) { console.log('  Keeping it.\n'); rl.close(); return; }
  } else {
    copyFileSync(EXAMPLE, ENV);
  }

  let body = readFileSync(ENV, 'utf8');

  console.log(`${B}GitLab${X}`);
  const found = existingGitlabToken();
  if (found) console.log(`  ${G}Found a GitLab token in ~/.claude.json — press Enter to reuse it.${X}`);
  const glToken = await ask('GITLAB_TOKEN', {
    default: found, secret: true,
    hint: found ? '' : 'Project access token, scope api. Settings → Access Tokens.',
  });
  body = setKey(body, 'GITLAB_TOKEN', glToken);

  console.log(`\n${B}Repositories${X}`);
  const work = await ask('WORK_REPO', {
    default: detectRepo('workstreamai') || '~/Documents/workstreamai',
    hint: 'Clone of the project Oneshot builds in. Worktrees are cut from it.',
  });
  const ctx = await ask('CONTEXT_REPO', {
    default: detectRepo('erp') || '~/Documents/erp',
    hint: 'Read-only reference AND the source of every skill.',
  });
  body = setKey(body, 'WORK_REPO', work);
  body = setKey(body, 'CONTEXT_REPO', ctx);
  body = setKey(body, 'ONESHOT_SKILLS_ROOT', `${ctx}/.claude`);
  body = setKey(body, 'ONESHOT_SEED_FROM', ctx);

  console.log(`\n${B}Slack${X} ${D}(optional — Enter to skip, status stays on the console)${X}`);
  const slackToken = await ask('SLACK_BOT_TOKEN', {
    secret: true,
    hint: 'xoxb- token. Scopes: chat:write, chat:write.public, files:write, channels:history.',
  });
  if (slackToken) {
    body = setKey(body, 'SLACK_BOT_TOKEN', slackToken);
    body = setKey(body, 'ONESHOT_CHANNEL',
      await ask('ONESHOT_CHANNEL', { hint: 'Channel id (C0…), from View channel details.' }));
    body = setKey(body, 'ONESHOT_OWNER_SLACK_ID',
      await ask('ONESHOT_OWNER_SLACK_ID', { hint: 'Your user id (U…) — the @mention on BLOCKED.' }));
  }

  console.log(`\n${B}Session tracking${X} ${D}(optional — Langfuse)${X}`);
  const lfPub = await ask('LANGFUSE_PUBLIC_KEY', { secret: true, hint: 'pk-lf-… Enter to skip.' });
  if (lfPub) {
    body = setKey(body, 'LANGFUSE_PUBLIC_KEY', lfPub);
    body = setKey(body, 'LANGFUSE_SECRET_KEY', await ask('LANGFUSE_SECRET_KEY', { secret: true }));
    const host = await ask('LANGFUSE_BASE_URL', {
      default: 'http://localhost:3000',
      hint: 'http://localhost:3000 self-hosted, or https://cloud.langfuse.com',
    });
    body = setKey(body, 'LANGFUSE_BASE_URL', host);
    if (!/localhost|127\.0\.0\.1/.test(host)) {
      console.log(`  ${Y}That endpoint is remote. Spans carry file paths and command arguments`);
      console.log(`  from your codebase — structural metadata, not source or prompts.${X}`);
      const ok = await ask('Send them off this machine? (y/N)', { default: 'N' });
      body = setKey(body, 'ONESHOT_OTEL_ALLOW_REMOTE', /^y/i.test(ok) ? '1' : '');
    }
  }

  writeFileSync(ENV, body);
  chmodSync(ENV, 0o600);
  console.log(`\n${G}Wrote .env (mode 600, gitignored).${X}`);

  console.log(`\n${B}Guardrail hooks${X}`);
  const install = await ask('Install them into ~/.claude/settings.json? (Y/n)', { default: 'Y' });
  if (/^y/i.test(install)) {
    try {
      execFileSync('node', [join(ROOT, 'scripts/install-hooks.cjs')], { stdio: 'inherit' });
    } catch {
      console.log(`  ${Y}Hook install failed — run 'npm run hooks:install' by hand.${X}`);
    }
  }

  rl.close();
  console.log(`\n${G}Done.${X} Next: ${B}npm run doctor${X} to check everything, then ${B}npm start${X}.\n`);
}

main().catch((err) => {
  rl.close();
  console.error(`\nsetup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
