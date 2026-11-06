/**
 * `npm run setup` — first-run wizard, interactive or not.
 *
 *   npm run setup                                    prompts (needs a terminal)
 *   npm run setup -- --from-env [--env-file <path>]  no prompts: values from the
 *                                                    process env, then the file
 *
 * `npm start` calls the interactive form when there is no .env, so a fresh desk
 * is `npm install && npm start`. A server runs the --from-env form from
 * scripts/setup-server.sh with /etc/oneshot/oneshot.env.
 *
 * The .env is built IN MEMORY and written once, at the very end, atomically
 * (temp file at mode 600, then rename). A wizard interrupted half way, a closed
 * stdin, or a --from-env run missing a required key leaves no .env behind — the
 * file that would make `npm start` skip the wizard and then refuse to boot.
 * A reconfigure that changes something first copies the old .env to
 * .env.bak-<timestamp> (mode 600).
 *
 * Guardrail hooks are passed to the SDK in-process (src/conductor/hooks.ts);
 * there is nothing to install.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupFile, legacyLines, pinPath, readKey, removeLegacySelectors, setKey } from '../src/lib/envfile.js';
import {
  EXAMPLE_URL, defaultWorkRepo, defaultWtRoot, isPlaceholder, parseRepoUrl, readEnv, type GitlabRepo,
} from '../src/lib/repourl.cjs';
import { loadEnvFiles, parseEnvText } from '../src/lib/appenv.cjs';

const ROOT = join(import.meta.dirname, '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');
const SERVER_EXAMPLE = join(ROOT, 'deploy', 'oneshot.env.example');

const plain = !process.stdout.isTTY || Boolean(process.env.NO_COLOR);
const [G, Y, R, D, B, X] = plain ? ['', '', '', '', '', ''] : ['\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[2m', '\x1b[1m', '\x1b[0m'];

/** Write `body` to .env in one step: a reader sees the old file or the new one, never half of either. */
function writeEnvAtomic(body: string): string {
  const existing = existsSync(ENV) ? readFileSync(ENV, 'utf8') : null;
  if (existing === body) return 'unchanged';
  const backup = existing !== null ? backupFile(ENV) : '';
  const tmp = `${ENV}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, ENV);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
  return backup ? `written; previous saved as ${backup}` : 'written';
}

/** Every key the template documents, set or commented out. */
function documentedKeys(file: string): string[] {
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
}

// ------------------------------------------------------------ --from-env

interface FromEnvResult { body: string; missing: string[]; notes: string[]; keys: string[] }

/**
 * The .env a --from-env run would write, from `source` — or the list of
 * required keys it lacks. Pure: reads only the templates and the current .env.
 */
function composeFromEnv(source: Record<string, string | undefined>, fileKeys: string[]): FromEnvResult {
  const missing: string[] = [];
  const notes: string[] = [];
  let repo: GitlabRepo | null = null;
  const url = readEnv(source, 'GITLAB_REPO_URL');
  if (!url) missing.push('GITLAB_REPO_URL (the GitLab project URL, e.g. https://gitlab.arbisoft.com/arbisoft/erp)');
  else {
    try { repo = parseRepoUrl(url); } catch (err) { missing.push(`GITLAB_REPO_URL is invalid: ${(err as Error).message}`); }
  }
  const token = readEnv(source, 'ONESHOT_GITLAB_TOKEN') || readEnv(source, 'GITLAB_TOKEN');
  if (!token) missing.push('ONESHOT_GITLAB_TOKEN or GITLAB_TOKEN (GitLab token, scope api)');
  const login = readEnv(source, 'ONESHOT_TEST_LOGIN');
  if (!login || !login.includes(':')) missing.push('ONESHOT_TEST_LOGIN (email:password of the local app test user)');
  if (missing.length || !repo) return { body: '', missing, notes, keys: [] };

  let body = existsSync(ENV) ? readFileSync(ENV, 'utf8') : readFileSync(EXAMPLE, 'utf8');
  if (legacyLines(body).length) {
    notes.push(`removed legacy selector lines: ${legacyLines(body).map((l) => l.split('=')[0]).join(', ')}`);
    body = removeLegacySelectors(body);
  }

  const keys = [...new Set([...documentedKeys(EXAMPLE), ...documentedKeys(SERVER_EXAMPLE), ...fileKeys])]
    .filter((k) => k !== 'ONESHOT_SEED_FROM');
  const written: string[] = [];
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === '' || isPlaceholder(value)) continue;
    if (/[\r\n]/.test(value)) { notes.push(`${key} skipped: multi-line values are not supported in .env`); continue; }
    body = setKey(body, key, value);
    written.push(key);
  }
  if (!readEnv(source, 'GITLAB_TOKEN')) {
    body = setKey(body, 'GITLAB_TOKEN', token);
    written.push('GITLAB_TOKEN');
    notes.push('GITLAB_TOKEN set from ONESHOT_GITLAB_TOKEN (boot requires it)');
  }

  const work = readEnv(source, 'WORK_REPO') || defaultWorkRepo(repo.name);
  const seed = readEnv(source, 'ONESHOT_SEED_FROM') || work;
  body = pinPath(body, { envName: 'ONESHOT_SEED_FROM', name: repo.name, answer: seed, derived: '', root: ROOT });
  written.push('ONESHOT_SEED_FROM');
  if (!readEnv(source, 'WORK_REPO')) notes.push(`WORK_REPO unset: the default ${work} applies — set it explicitly on a server`);
  return { body, missing, notes, keys: [...new Set(written)].sort() };
}

function fromEnv(envFile: string): number {
  console.log(`\n${B}Oneshot setup (non-interactive)${X}\n`);
  if (envFile && !existsSync(envFile)) {
    console.error(`${R}--env-file ${envFile} does not exist.${X} Nothing was written.`);
    return 1;
  }
  const source: Record<string, string | undefined> = { ...process.env };
  const fileKeys = envFile ? Object.keys(parseEnvText(readFileSync(envFile, 'utf8'))) : [];
  if (envFile) loadEnvFiles([envFile], source);

  const r = composeFromEnv(source, fileKeys);
  if (r.missing.length) {
    console.error(`${R}Missing required settings${X} (from the environment${envFile ? ` or ${envFile}` : ''}):`);
    for (const m of r.missing) console.error(`  - ${m}`);
    console.error(`\nNothing was written${existsSync(ENV) ? '; the existing .env is untouched' : ''}.`);
    return 1;
  }
  const outcome = writeEnvAtomic(r.body);
  for (const n of r.notes) console.log(`  ${Y}note${X} ${n}`);
  console.log(`  ${G}.env ${outcome}${X} ${D}(mode 600; keys: ${r.keys.join(', ')})${X}`);
  console.log(`\nNext: ${B}npm run doctor${X}\n`);
  return 0;
}

// ---------------------------------------------------------- interactive

let rl: Interface | null = null;

async function ask(label: string, opts: { default?: string; secret?: boolean; hint?: string } = {}): Promise<string> {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
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

async function interactive(): Promise<number> {
  console.log(`\n${B}Oneshot setup${X}\n`);
  if (!process.stdin.isTTY) {
    console.error(`${R}stdin is not a terminal, so there is nobody to answer the prompts.${X}`);
    console.error('Run it non-interactively instead:  npm run setup -- --from-env [--env-file <path>]');
    console.error('Nothing was written.');
    return 1;
  }

  const reconfigure = existsSync(ENV);
  if (reconfigure) {
    const overwrite = await ask('.env already exists. Reconfigure it? (y/N)', { default: 'N' });
    if (!/^y/i.test(overwrite)) { console.log('  Keeping it.\n'); return 0; }
  }
  let body = readFileSync(reconfigure ? ENV : EXAMPLE, 'utf8');

  console.log(`${B}GitLab${X}`);
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
  // an old line removed when it does not: a reconfigure starts from the
  // existing .env, where a path from the previous project would otherwise win.
  body = pinPath(body, { envName: 'WORK_REPO', name: repo.name, answer: work, derived, root: ROOT });
  body = pinPath(body, { envName: 'WT_ROOT', name: repo.name, answer: wt, derived: derivedWt, root: ROOT });
  body = setKey(body, 'CONTEXT_REPO', ctx);
  body = setKey(body, 'ONESHOT_SKILLS_ROOT', '');
  body = pinPath(body, { envName: 'ONESHOT_SEED_FROM', name: repo.name, answer: work, derived: '', root: ROOT });

  console.log(`\n${B}Local app login${X}`);
  const login = await ask('ONESHOT_TEST_LOGIN', {
    secret: true, hint: 'email:password of the app user verify logs in as. Enter to skip.',
  });
  body = setKey(body, 'ONESHOT_TEST_LOGIN', login);

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

  const outcome = writeEnvAtomic(body);
  console.log(`\n${G}.env ${outcome}${X} ${D}(mode 600, gitignored)${X}`);
  console.log(`\n${G}Done.${X} Next: ${B}npm run doctor${X} to check everything, then ${B}npm start${X}.\n`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--env-file');
  const envFile = at >= 0 ? argv[at + 1] ?? '' : '';
  if (at >= 0 && !envFile) { console.error('--env-file needs a path'); return 1; }
  if (argv.includes('--from-env') || envFile) return fromEnv(envFile);
  return interactive();
}

main()
  .then((code) => { rl?.close(); process.exit(code); })
  .catch((err) => {
    rl?.close();
    console.error(`\nsetup failed: ${(err as Error).message}\nNothing was written unless it says so above.\n`);
    process.exit(1);
  });
