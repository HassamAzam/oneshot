/**
 * `npm run setup` — interactive first-run wizard.
 *
 * `npm start` calls this automatically when there is no .env, so a fresh clone
 * is `npm install && npm start` and nothing else. GITLAB_REPO_URL comes first and
 * has no default — it is the one fact the machine cannot guess, and the prompt
 * repeats until it gets a valid URL. After it, every prompt either defaults
 * (the paths derive from the URL) or can be skipped with Enter. GITLAB_TOKEN
 * defaults only when ~/.claude.json already holds one; skipped, it leaves the
 * .env.example placeholder, and boot refuses until a token is filled in.
 *
 * Secrets are written to .env at mode 600 and never echoed back.
 */
import { createInterface } from 'node:readline/promises';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { legacyLines, pinPath, readKey, removeLegacySelectors, setKey } from '../src/lib/envfile.js';
import { EXAMPLE_URL, defaultWorkRepo, defaultWtRoot, parseRepoUrl, type GitlabRepo } from '../src/lib/repourl.cjs';

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
  // First, because everything else is derived from it: the API, the token page,
  // and the default location of the clone asked for below.
  let repo: GitlabRepo | null = null;
  while (!repo) {
    const url = await ask('GITLAB_REPO_URL', {
      hint: `The project Oneshot works on, as its web or clone URL — e.g. ${EXAMPLE_URL}`,
    });
    try {
      repo = parseRepoUrl(url);
    } catch (err) {
      console.log(`  ${Y}${(err as Error).message}${X}`);
    }
  }
  body = setKey(body, 'GITLAB_REPO_URL', repo.url);

  // A reconfigure keeps the old .env, so the lines that used to select the
  // project may still be in it. They select nothing now, and one that
  // disagrees with the URL just given refuses boot.
  const legacy = legacyLines(body);
  if (legacy.length) {
    console.log(`  ${Y}${legacy.join(', ')} ${legacy.length === 1 ? 'is' : 'are'} left from before GITLAB_REPO_URL `
      + `and select${legacy.length === 1 ? 's' : ''} nothing now.${X}`);
    const drop = await ask('Remove them from .env? (Y/n)', { default: 'Y' });
    if (/^y/i.test(drop)) body = removeLegacySelectors(body);
  }

  const found = existingGitlabToken();
  if (found) console.log(`  ${G}Found a GitLab token in ~/.claude.json — press Enter to reuse it.${X}`);
  const glToken = await ask('GITLAB_TOKEN', {
    default: found, secret: true,
    hint: found ? '' : 'Project access token, scope api. Settings → Access Tokens.',
  });
  body = setKey(body, 'GITLAB_TOKEN', glToken);

  console.log(`\n${B}Repositories${X}`);
  const derived = defaultWorkRepo(repo.name);
  const work = await ask('WORK_REPO', {
    default: detectRepo(repo.name) || derived,
    hint: `Your clone of ${repo.project}. Worktrees are cut from it; its origin must be that project.`,
  });
  const ctx = await ask('CONTEXT_REPO', {
    default: detectRepo('erp') || '~/Documents/erp',
    hint: 'Read-only reference for prior art and conventions.',
  });
  const derivedWt = defaultWtRoot(repo.name);
  const oldWt = readKey(body, 'WT_ROOT');
  const wt = await ask('WT_ROOT', {
    default: derivedWt,
    hint: `Where per-ticket worktrees go — one directory per project, since they are named by ticket iid.`
      + (oldWt && oldWt !== derivedWt ? ` .env currently says ${oldWt}.` : ''),
  });
  // Pinned only when an answer differs from what GITLAB_REPO_URL derives, and
  // an old line REMOVED when it does not: a reconfigure starts from the
  // existing .env, where a WORK_REPO or WT_ROOT from the previous project would
  // otherwise outrank the answer just given.
  body = pinPath(body, { envName: 'WORK_REPO', name: repo.name, answer: work, derived, root: ROOT });
  body = pinPath(body, { envName: 'WT_ROOT', name: repo.name, answer: wt, derived: derivedWt, root: ROOT });
  body = setKey(body, 'CONTEXT_REPO', ctx);
  // Skills/agents/rules are vendored into this repo's context/, so leave
  // ONESHOT_SKILLS_ROOT empty to use that self-contained default. Set it only
  // to override with a live .claude (e.g. `${ctx}/.claude`).
  body = setKey(body, 'ONESHOT_SKILLS_ROOT', '');
  // The seed is the installed clone worktrees borrow node_modules and venv
  // from, and scripts/app.cjs also fetches refs from it — so it has to be a
  // clone of the same project, which the work repo is by definition.
  body = pinPath(body, { envName: 'ONESHOT_SEED_FROM', name: repo.name, answer: work, derived: '', root: ROOT });

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
