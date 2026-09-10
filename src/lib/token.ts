/**
 * Where this desk's GitLab token comes from, and therefore who this desk IS.
 *
 * THE POINT
 * ---------
 * A shared `GITLAB_TOKEN` in `.env` is one person's credential doing everybody's
 * work. Whoever's token it is, that is who comments on the ticket, pushes the
 * branch and accepts the merge request — regardless of who the ticket is
 * assigned to, and regardless of whose laptop it runs on. On this instance that
 * account is also on `config/reviewers.json`, so the pipeline's own notes have
 * read as review feedback.
 *
 * So the token is now resolved PER DESK, from the operator's own machine, and it
 * is the source of identity rather than something checked against one:
 *
 *     whichever token this desk owns  --GET /user-->  this desk's username
 *
 * There is no second fact to keep in sync. A desk cannot select tickets as one
 * person and act as another, because there is only ever one person involved.
 *
 * RESOLUTION ORDER
 * ----------------
 * Local sources win. `.env` is last and warns, because a shared token in a repo
 * checkout is exactly the arrangement this module exists to retire.
 *
 *   1. ONESHOT_GITLAB_TOKEN     explicit, for CI and for an operator who wants
 *                               to be unambiguous
 *   2. ~/.config/oneshot/gitlab-token   the per-desk file. No dependency, works
 *                               headless, lives outside every repo so it cannot
 *                               be committed. `npm run token:set` writes it 0600.
 *   3. macOS keychain            service `oneshot-gitlab`, for a desk that
 *                               prefers it. Read with `security -w`.
 *   4. glab CLI                  ~/.config/glab-cli/config.yml, if the operator
 *                               already ran `glab auth login`.
 *   5. GITLAB_TOKEN              the legacy shared token. Still works; warns.
 *
 * NOT a source: the git credential helper. Both GitLab remotes here are SSH
 * (`git@gitlab.arbisoft.com:…`), and an SSH key cannot call the REST API — so
 * there is nothing to read, and looking would only produce a confusing miss.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export type TokenSource =
  | 'ONESHOT_GITLAB_TOKEN' | 'desk-file' | 'keychain' | 'glab' | 'GITLAB_TOKEN' | 'none';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** Where a human should look to change it. Never contains the value. */
  where: string;
  /** True when this is the shared .env token the per-desk model replaces. */
  shared: boolean;
}

export const DESK_TOKEN_FILE = join(homedir(), '.config', 'oneshot', 'gitlab-token');
const KEYCHAIN_SERVICE = 'oneshot-gitlab';

const env = (n: string): string => process.env[n]?.trim() || '';

function fromFile(): string {
  try {
    // First non-empty, non-comment line. An operator will paste a trailing
    // newline and sooner or later a comment; neither should break auth in a way
    // that surfaces as a 401 three phases later.
    return readFileSync(DESK_TOKEN_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || '';
  } catch { return ''; }
}

function fromKeychain(): string {
  if (process.platform !== 'darwin') return '';
  const r = spawnSync('security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function fromGlab(): string {
  const cfg = join(homedir(), '.config', 'glab-cli', 'config.yml');
  if (!existsSync(cfg)) return '';
  try {
    // Deliberately a line scan rather than a YAML dependency: the file is a flat
    // hosts map and a parser is a package this repo does not otherwise need.
    const m = readFileSync(cfg, 'utf8').match(/^\s*token:\s*(\S+)\s*$/m);
    return m?.[1] ?? '';
  } catch { return ''; }
}

/**
 * Resolve the token this desk should act with.
 *
 * Never throws and never logs the value. A caller that gets `source: 'none'`
 * should say what to run, not what went wrong.
 */
export function resolveToken(): ResolvedToken {
  const explicit = env('ONESHOT_GITLAB_TOKEN');
  if (explicit) {
    return { token: explicit, source: 'ONESHOT_GITLAB_TOKEN', where: 'the ONESHOT_GITLAB_TOKEN environment variable', shared: false };
  }
  const file = fromFile();
  if (file) {
    return { token: file, source: 'desk-file', where: DESK_TOKEN_FILE, shared: false };
  }
  const kc = fromKeychain();
  if (kc) {
    return { token: kc, source: 'keychain', where: `the macOS keychain, service "${KEYCHAIN_SERVICE}"`, shared: false };
  }
  const glab = fromGlab();
  if (glab) {
    return { token: glab, source: 'glab', where: '~/.config/glab-cli/config.yml (glab auth login)', shared: false };
  }
  const shared = env('GITLAB_TOKEN');
  if (shared) {
    return { token: shared, source: 'GITLAB_TOKEN', where: "GITLAB_TOKEN in this repo's .env", shared: true };
  }
  return { token: '', source: 'none', where: 'nowhere', shared: false };
}

/** Write the per-desk token file, 0600, creating its directory. */
export function writeDeskToken(token: string): string {
  mkdirSync(dirname(DESK_TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(DESK_TOKEN_FILE, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(DESK_TOKEN_FILE, 0o600);
  return DESK_TOKEN_FILE;
}

/** What to tell an operator who has no token yet. */
export const SETUP_HINT =
  'Give this desk its own GitLab token:  npm run token:set\n'
  + '  Create one at https://gitlab.arbisoft.com/-/user_settings/personal_access_tokens\n'
  + '  with scope `api`. It is written to ~/.config/oneshot/gitlab-token, mode 0600,\n'
  + '  outside every repo. The conductor then acts as YOU, and only claims tickets\n'
  + '  assigned to you.';
