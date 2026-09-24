'use strict';
/**
 * Which GitLab project Oneshot works on, and where this machine keeps it.
 *
 * ONE variable answers the first question: GITLAB_REPO_URL. Host, API root,
 * project path, web URL and the short "target name" are all DERIVED from it,
 * and the default checkout (~/Documents/<name>) and worktree root
 * (~/Documents/<name>-wt) are derived from that name. Nothing about the project
 * is configured anywhere else, so there is nothing else to fall out of step
 * with it.
 *
 * WHY THIS IS A .cjs FILE
 * -----------------------
 * Two runtimes have to reach the same answer. The conductor is TypeScript
 * (src/lib/config.ts, identity.ts, token.ts); scripts/app.cjs is CommonJS that
 * phase sessions run standalone, with no conductor to inherit from. Before this
 * module each side carried its own copy of the resolution rules, and the copies
 * had already drifted (the ONELOOP_ spelling, the placeholder screen, what a
 * relative path is relative to). A dependency-free CommonJS module is the one
 * thing both can load, so the rules live here once and cannot disagree.
 *
 * It must stay dependency-free and side-effect-free: identity.ts and token.ts
 * import it precisely because they cannot import config.ts (config.ts imports
 * them), and every function here reads the environment it is HANDED rather
 * than one it captured at load. The one function that touches anything outside
 * its arguments is readOrigin(), the git call behind the origin check, kept
 * here so both runtimes read a remote the same way; the judgement of what it
 * read, judgeOrigin(), is pure.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_URL_VAR = 'GITLAB_REPO_URL';
const EXAMPLE_URL = 'https://gitlab.example.com/group/project';

/**
 * An unreplaced placeholder from .env.example.
 *
 * Treated as unset, not as a value. Otherwise `SLACK_BOT_TOKEN=xoxb-REPLACE_ME`
 * satisfies every "is it configured" check and the failure only surfaces later
 * as an opaque `invalid_auth` from the API.
 */
function isPlaceholder(v) {
  return /REPLACE_ME|<[a-z-]+>|CHANGE_?ME|your-.*-here/i.test(String(v));
}

/**
 * The narrower screen GITLAB_REPO_URL gets: only REPLACE_ME and a `<name>`
 * marker, which never occur in a real project URL. `changeme` and
 * `your-…-here` do — a project called `exchangemedia` is a real project.
 */
function isUrlPlaceholder(v) {
  return /REPLACE_ME|<[a-z-]+>/i.test(String(v));
}

function usable(v) {
  return typeof v === 'string' && v !== '' && !isPlaceholder(v);
}

/**
 * The variable that actually supplies `name`, and its value — or null.
 *
 * Accepts the legacy ONELOOP_ spelling for any ONESHOT_ name so an existing
 * One Loop .env keeps working; ONESHOT_ wins. Returning the KEY as well as the
 * value is what lets a caller name the line a person has to edit.
 */
function envEntry(env, name) {
  for (const key of spellings(name)) if (usable(env[key])) return { key, value: env[key] };
  return null;
}

/** `name`, and for an ONESHOT_ name its legacy ONELOOP_ spelling after it. */
function spellings(name) {
  return name.startsWith('ONESHOT_') ? [name, `ONELOOP_${name.slice('ONESHOT_'.length)}`] : [name];
}

/** `envOr` over a given environment: blank and placeholder values count as unset. */
function readEnv(env, name, fallback = '') {
  const e = envEntry(env, name);
  return e ? e.value : fallback;
}

/**
 * A remote URL fit to print: an http(s) URL loses its userinfo entirely, any
 * other URL loses a password. `https://oauth2:<token>@host/…` is how a clone
 * made with a token records its origin, and these URLs end up in boot logs and
 * doctor output.
 */
function redactUrl(url) {
  return String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i,
    (whole, scheme, user) => (/^https?:/i.test(scheme) || user.includes(':') ? scheme : whole));
}

function invalid(raw, why) {
  raw = redactUrl(raw);
  return new Error(
    `${REPO_URL_VAR}='${raw}' is not a GitLab project URL (${why}). `
    + `Expected e.g. ${REPO_URL_VAR}=${EXAMPLE_URL} or git@gitlab.example.com:group/project.git`,
  );
}

/** A GitLab path segment: what GitLab itself allows in a group or project path. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Pages GitLab serves UNDER a project path without the `/-/` separator — its
 * older route style, still what some bookmarks and pasted links look like.
 * Most are names GitLab reserves for projects, so no real subgroup path can
 * contain them past the namespace/project prefix. Without this,
 * `…/group/erp/issues/12` parses as a project `group/erp/issues/12` named `12`,
 * and every message after that points at the wrong fix: a WORK_REPO default of
 * ~/Documents/12, a correct ONESHOT_PROJECT=erp reported as the conflict.
 */
const PROJECT_ROUTES = new Set([
  'issues', 'merge_requests', 'tree', 'blob', 'raw', 'blame', 'commits', 'commit', 'compare',
  'pipelines', 'jobs', 'wikis', 'branches', 'tags', 'edit', 'find_file',
]);
/** Top-level routes that are GitLab pages, never a namespace: `/groups/<g>`, `/projects/<id>`. */
const TOP_ROUTES = new Set(['groups', 'projects']);

/**
 * Parse a GitLab project URL in any of the shapes a person is likely to paste.
 *
 *   https://host/group/project            the web URL (http, an explicit port kept)
 *   https://host/group/project.git        the HTTPS clone URL; a trailing / too
 *   https://host/group/project/-/issues/7 a browser URL: everything from /-/ dropped
 *   https://host/group/sub/project        subgroups, any depth
 *   git@host:group/project.git            the SSH clone URL (scp form)
 *   ssh://git@host:2222/group/project.git the SSH clone URL (URL form)
 *
 * For an SSH form the API is assumed to be HTTPS on the same host, WITHOUT the
 * SSH port — that port is sshd's, not the web server's. An https URL keeps an
 * explicit port, because there it IS the web server's.
 *
 * Throws an Error naming GITLAB_REPO_URL and an example on anything else,
 * including an unset or placeholder value.
 */
function parseRepoUrl(raw) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) {
    throw new Error(
      `${REPO_URL_VAR} is not set. It names the GitLab project Oneshot works on — put it in .env, `
      + `e.g. ${REPO_URL_VAR}=${EXAMPLE_URL}`,
    );
  }
  if (isUrlPlaceholder(input)) {
    throw new Error(
      `${REPO_URL_VAR} is still the placeholder '${input}'. Replace it with the project's URL, `
      + `e.g. ${REPO_URL_VAR}=${EXAMPLE_URL}`,
    );
  }

  let scheme;
  let host;
  let hostname;
  let rawPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let u;
    try { u = new URL(input); } catch { throw invalid(input, 'not a parseable URL'); }
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    if (proto === 'http' || proto === 'https') {
      scheme = proto;
      host = u.host.toLowerCase();
    } else if (proto === 'ssh' || proto === 'git+ssh' || proto === 'ssh+git') {
      scheme = 'https';
      host = u.hostname.toLowerCase();
    } else {
      throw invalid(input, `unsupported scheme '${proto}' — use https:// or an SSH clone URL`);
    }
    hostname = u.hostname.toLowerCase();
    try { rawPath = decodeURIComponent(u.pathname); } catch { rawPath = u.pathname; }
  } else {
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(input);
    if (!scp) throw invalid(input, 'neither an http(s) URL nor an SSH clone URL');
    // `https:/host/…` (one slash) would otherwise read as SSH to a host called
    // "https", pass every check here and fail later as a DNS error.
    if (/^(?:https?|ssh|git|file|git\+ssh|ssh\+git)$/i.test(scp[1])) {
      throw invalid(input, `malformed URL — did you mean ${scp[1].toLowerCase()}://…?`);
    }
    scheme = 'https';
    host = scp[1].toLowerCase();
    hostname = host;
    rawPath = scp[2];
  }
  if (!hostname) throw invalid(input, 'no host');

  const trimmed = rawPath
    .replace(/\/-(\/.*)?$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '');
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw invalid(input, 'it needs a namespace and a project, like group/project');
  }
  const bad = segments.find((s) => !SEGMENT.test(s) || s.endsWith('.'));
  if (bad) throw invalid(input, `'${bad}' is not a valid GitLab path segment`);
  if (TOP_ROUTES.has(segments[0].toLowerCase())) {
    throw invalid(input, `'/${segments[0]}/…' is a GitLab page, not a project — paste the project's own URL`);
  }
  const route = segments.findIndex((s, i) => i >= 2 && PROJECT_ROUTES.has(s.toLowerCase()));
  if (route !== -1) {
    throw invalid(input, `'${segments[route]}' is a GitLab page, not part of a project path — `
      + `did you mean ${scheme}://${host}/${segments.slice(0, route).join('/')}?`);
  }

  const project = segments.join('/');
  const origin = `${scheme}://${host}`;
  return {
    url: input,
    scheme,
    host,
    hostname,
    origin,
    apiUrl: `${origin}/api/v4`,
    project,
    webUrl: `${origin}/${project}`,
    sshUrl: `git@${hostname}:${project}.git`,
    name: segments[segments.length - 1].toLowerCase(),
  };
}

/**
 * GITLAB_REPO_URL from `env`, parsed — never throws.
 *
 * `error` is the message parseRepoUrl would have thrown, for a caller that has
 * to decide how loudly to say it (a boot refusal, a doctor FAIL, an import that
 * must not throw at all).
 */
function repoFromEnv(env) {
  const raw = env[REPO_URL_VAR];
  try {
    return { repo: parseRepoUrl(typeof raw === 'string' ? raw : ''), error: null };
  } catch (err) {
    return { repo: null, error: err.message };
  }
}

/**
 * What two remotes have to agree on to be the same project: hostname and path,
 * lower-cased, with the scheme, user, port and `.git` dropped. `null` for
 * anything that is not a recognisable GitLab project URL.
 *
 * The port is dropped because the SAME project is legitimately reached on two
 * of them — https on 443, ssh on 22 or 2222 — and those must compare equal.
 */
function repoKey(url) {
  try {
    const r = parseRepoUrl(url);
    return `${r.hostname}/${r.project.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** How many local clones readOrigin() follows before giving up on finding a GitLab URL. */
const MAX_LOCAL_HOPS = 3;

/**
 * The directory a remote URL points at when it is a local clone — a path or a
 * file:// URL — else null. A relative path is relative to the checkout, as git
 * reads it. `host:path` is git's scp form, not a path.
 */
function localRemotePath(url, dir) {
  if (/^file:\/\//i.test(url)) {
    try { return require('node:url').fileURLToPath(url); } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]*:/.test(url)) return null;
  return path.resolve(dir, url);
}

/**
 * What `git remote` says about `dir`'s origin: the fetch URL and every push URL
 * (a `remote.origin.pushurl` sends pushes somewhere the fetch URL does not
 * mention). `{ error }` when there is nothing to read — not a directory, not a
 * repository, no origin, git missing. Never throws.
 *
 * An origin that is a LOCAL clone (a path, file://) is followed to that
 * clone's own origin, up to MAX_LOCAL_HOPS, because it would otherwise hide
 * which project the checkout is; `via` lists the local hops. A clone of a local
 * clone of group/project is a clone of group/project.
 */
function readOrigin(dir, hops = MAX_LOCAL_HOPS) {
  if (!dir || !fs.existsSync(dir)) return { error: `${dir || '(no path)'} does not exist` };
  const run = (args) => spawnSync('git', ['-C', dir, 'remote', 'get-url', ...args, 'origin'],
    { encoding: 'utf8', timeout: 15000 });
  const r = run([]);
  if (r.error) return { error: `git could not run: ${r.error.message}` };
  if (r.status !== 0) {
    const why = String(r.stderr || '').trim().split('\n').pop() || `git exited ${r.status}`;
    return { error: why };
  }
  const url = String(r.stdout || '').trim();
  if (!url) return { error: 'origin has no URL' };
  const p = run(['--push', '--all']);
  const pushUrls = p.status === 0
    ? String(p.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l && l !== url)
    : [];

  const local = localRemotePath(url, dir);
  if (local && hops > 0) {
    const inner = readOrigin(local, hops - 1);
    if (!('error' in inner)) return { url: inner.url, pushUrls, via: [url, ...(inner.via || [])] };
  }
  return { url, pushUrls };
}

/** parseRepoUrl()'s hostname and lower-cased path for `url`; null if unparseable. */
function repoParts(url) {
  try {
    const r = parseRepoUrl(url);
    return { host: r.hostname, path: r.project.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Judge a checkout's origin against the project. Pure; `read` is readOrigin()'s answer.
 *
 * `subject` says what the checkout is to Oneshot and where its path came from:
 * `{ label: 'WORK_REPO' | 'ONESHOT_SEED_FROM', dir, from }`, `from` being the
 * resolvePath() result. The fix-it text depends on it, because the right
 * advice does: deleting a plain WORK_REPO line falls back to the derived
 * default, deleting a scoped one falls back to the plain one, a derived default
 * has no line to delete at all, and deleting ONESHOT_SEED_FROM switches seeding
 * off for the conductor.
 *
 * A proven mismatch fails: the fetch URL or any push URL parses as a GitLab
 * project whose PATH is another project's. Anything that proves nothing either
 * way only warns: no origin, not a repository, an origin that is not a GitLab
 * URL at all (a local clone whose chain never reached one), or the same path on
 * a host that is not GITLAB_REPO_URL's — an ~/.ssh/config alias, or the
 * instance's separate ssh hostname, both of which are the right project reached
 * by another name.
 */
function judgeOrigin(subject, repoUrl, read) {
  const label = subject.label;
  const shownRepo = redactUrl(repoUrl);
  if ('error' in read) {
    return {
      level: 'warn',
      label: `${label} origin unknown`,
      detail: `${read.error} — cannot confirm it is a clone of ${shownRepo}`,
    };
  }
  const want = repoParts(repoUrl);
  const urls = [{ url: read.url, push: false }, ...(read.pushUrls || []).map((u) => ({ url: u, push: true }))];
  const judged = urls.map((u) => ({ ...u, parts: repoParts(u.url) }));
  const where = subject.dir ? `${subject.dir}: ` : '';
  const shown = (u) => {
    const own = u.push ? `pushes to ${redactUrl(u.url)}` : `is ${redactUrl(u.url)}`;
    if (u.push || !read.via || !read.via.length) return `its origin ${own}`;
    return `its origin is the local clone ${redactUrl(read.via[0])}, whose origin is ${redactUrl(u.url)}`;
  };
  const wrong = want && judged.find((u) => u.parts && u.parts.path !== want.path);
  if (wrong) {
    return {
      level: 'fail',
      label: `${label} is a clone of another project`,
      detail: `${where}${shown(wrong)}, but ${REPO_URL_VAR} is ${shownRepo}. `
        + `${originRemedy(subject, shownRepo, wrong.push)}`,
    };
  }
  const unknown = judged.find((u) => u.parts === null);
  if (!want || unknown) {
    const u = unknown || judged[0];
    return {
      level: 'warn',
      label: `${label} origin unknown`,
      detail: `${where}${shown(u)}, which is not a GitLab project URL (a local path or file:// clone `
        + `whose own origin could not be read?) — cannot confirm it is a clone of ${shownRepo}`,
    };
  }
  const otherHost = judged.find((u) => u.parts.host !== want.host);
  if (otherHost) {
    return {
      level: 'warn',
      label: `${label} origin on another host`,
      detail: `${where}${shown(otherHost)} — the same project path as ${shownRepo}, but host `
        + `'${otherHost.parts.host}' is not '${want.host}'. Fine if it is an ssh alias or the instance's ssh `
        + 'hostname; otherwise it is a clone from another GitLab.',
    };
  }
  const via = read.via && read.via.length ? ` (via local clone ${redactUrl(read.via[0])})` : '';
  return { level: 'pass', label: `${label} origin`, detail: `${redactUrl(read.url)}${via}` };
}

function originRemedy(subject, repoUrl, push) {
  const { label, dir, from } = subject;
  const key = (from && from.key) || label;
  if (push) {
    return `Remove the stray push URL (git -C ${dir || label} config --unset-all remote.origin.pushurl), `
      + `or point ${key} at a clone of ${repoUrl}.`;
  }
  if (label === 'ONESHOT_SEED_FROM') {
    return `Point ${key} at an installed clone of ${repoUrl} — the WORK_REPO clone is one. `
      + 'Deleting the line is not the fix: the conductor then seeds nothing, and worktrees get no node_modules or venv.';
  }
  if (!from || !from.source) return `Point ${label} at a clone of ${repoUrl}.`;
  if (from.source === 'default') {
    return `That directory is the default derived from ${REPO_URL_VAR}: move it aside and clone ${repoUrl} `
      + `there, or set ${label} to a clone of it.`;
  }
  if (from.source === 'scoped') {
    return `${key} chose this path: point it at a clone of ${repoUrl}, or delete the ${key} line from .env `
      + `(a plain ${label}, else the default derived from ${REPO_URL_VAR}, then applies).`;
  }
  return `Point ${key} at a clone of ${repoUrl}, or delete the ${key} line from .env to use the default `
    + `derived from ${REPO_URL_VAR}.`;
}

/**
 * The per-machine, per-project spelling of a path variable:
 * `ONESHOT_<NAME>_<VAR>`, e.g. ONESHOT_ERP_WORK_REPO.
 *
 * A leading `ONESHOT_` is stripped before scoping so `ONESHOT_SEED_FROM`
 * scopes to `ONESHOT_ERP_SEED_FROM` rather than `ONESHOT_ERP_ONESHOT_SEED_FROM`.
 * With no name there is no scoped spelling at all — '' rather than
 * `ONESHOT__WORK_REPO`, a name nobody could mean.
 */
function scopedEnvName(name, envName) {
  const slug = String(name || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!slug) return '';
  return `ONESHOT_${slug}_${envName.replace(/^ONESHOT_/, '')}`;
}

/**
 * Expand a leading `~` and resolve against `root` — the Oneshot checkout, not
 * the process's cwd. A phase session runs scripts/app.cjs from inside a
 * worktree, and a relative WORK_REPO must not mean a different directory there
 * than it means to the conductor.
 */
function expandPath(p, root) {
  if (!p) return '';
  const expanded = String(p).replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(root, expanded);
}

function defaultWorkRepo(name) { return name ? `~/Documents/${name}` : ''; }
function defaultWtRoot(name) { return name ? `~/Documents/${name}-wt` : ''; }

/**
 * One path variable: scoped `ONESHOT_<NAME>_<VAR>` > plain `<VAR>` > `fallback`.
 *
 * The scoped form is the legacy per-machine spelling from when a project was a
 * named overlay. It is still honoured, above the plain one, because nobody
 * writes it except someone who meant that path for that project. `source` and
 * `key` say which one won, so doctor can say so.
 */
function resolvePath(env, opts) {
  const scopedKey = scopedEnvName(opts.name, opts.envName);
  const scoped = scopedKey ? envEntry(env, scopedKey) : null;
  if (scoped) return { path: expandPath(scoped.value, opts.root), source: 'scoped', key: scoped.key };
  const plain = envEntry(env, opts.envName);
  if (plain) return { path: expandPath(plain.value, opts.root), source: 'plain', key: plain.key };
  return { path: expandPath(opts.fallback, opts.root), source: 'default', key: '' };
}

/**
 * The project and the two paths every consumer agrees on, from `env`.
 *
 * Never throws. With GITLAB_REPO_URL unset or invalid, `repo` is null, `error`
 * says why, `name` is '' and the derived defaults are '' — so an explicitly set
 * WORK_REPO still resolves, and an unset one resolves to nothing rather than
 * to somebody else's project.
 */
function resolveTarget(env, root) {
  const { repo, error } = repoFromEnv(env);
  const name = repo ? repo.name : '';
  return {
    repo,
    error,
    name,
    workRepo: resolvePath(env, { name, envName: 'WORK_REPO', fallback: defaultWorkRepo(name), root }),
    wtRoot: resolvePath(env, { name, envName: 'WT_ROOT', fallback: defaultWtRoot(name), root }),
  };
}

const bare = (s) => String(s).trim().replace(/\/+$/, '').toLowerCase();

/**
 * The variables that USED to select the project. They select nothing now; the
 * only question left is whether one still set in somebody's .env agrees with
 * GITLAB_REPO_URL. `derived` is what the URL gives for it; null where that
 * cannot be known offline (the numeric id).
 */
const LEGACY_SELECTORS = [
  { name: 'ONESHOT_PROJECT', derive: (r) => r.name, norm: (s) => bare(s) },
  {
    name: 'ONESHOT_GITLAB_PROJECT',
    derive: (r) => r.project,
    norm: (s) => bare(s).replace(/^\/+/, '').replace(/\.git$/, ''),
  },
  { name: 'ONESHOT_GITLAB_API', derive: (r) => r.apiUrl, norm: (s) => bare(s) },
  { name: 'ONESHOT_PROJECT_ID', derive: () => null, norm: (s) => bare(s) },
];

/** Every legacy selector key, in both spellings. */
const LEGACY_SELECTOR_KEYS = LEGACY_SELECTORS.flatMap((sel) => spellings(sel.name));

/**
 * Every legacy selector set in `env`, in either spelling, judged against `repo`.
 *
 * Each spelling is checked on its own. Taking only the winning one, as `envOr`
 * would, lets a disagreeing ONELOOP_ line hide behind an agreeing ONESHOT_ one —
 * a stale value nobody is told about, which is the one outcome this exists to
 * rule out.
 *
 * `conflict` is true only when the value is checkable and DIFFERS. With no
 * `repo` nothing is checkable, so nothing conflicts: the missing URL is the
 * failure to report, and these are merely lines that no longer do anything.
 */
function legacySelectors(env, repo) {
  const out = [];
  for (const sel of LEGACY_SELECTORS) {
    for (const key of spellings(sel.name)) {
      const value = env[key];
      if (!usable(value) || !String(value).trim()) continue;
      const derived = repo ? sel.derive(repo) : null;
      const conflict = derived !== null && sel.norm(value) !== sel.norm(derived);
      out.push({ key, value: String(value).trim(), derived, conflict });
    }
  }
  return out;
}

module.exports = {
  REPO_URL_VAR,
  EXAMPLE_URL,
  isPlaceholder,
  redactUrl,
  envEntry,
  spellings,
  readEnv,
  parseRepoUrl,
  repoFromEnv,
  repoKey,
  readOrigin,
  localRemotePath,
  judgeOrigin,
  scopedEnvName,
  expandPath,
  defaultWorkRepo,
  defaultWtRoot,
  resolvePath,
  resolveTarget,
  LEGACY_SELECTOR_KEYS,
  legacySelectors,
};
