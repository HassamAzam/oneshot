/**
 * Who merged a run's MR — the answerer of the merge gate.
 *
 * The journal knows THAT the MR merged (mergedSha) but not who pressed the button:
 * on a Review run that is a person on GitLab, outside Oneshot. One GET of the MR
 * answers it. The answer never changes, so it is cached per run in
 * <stateDir>/mergers.json and asked at most once.
 *
 * The project and token are resolved exactly as the conductor resolves them
 * (src/lib/gitlab.ts): the project from GITLAB_REPO_URL, the token
 * GITLAB_READ_TOKEN > ONESHOT_GITLAB_TOKEN > ~/.config/oneshot/gitlab-token > GITLAB_TOKEN.
 * The keychain and glab sources are not read here; a desk relying on them gets null.
 * Like gitlab.ts it addresses the project by path, and on a ROUTE-404 (a front end
 * that decodes %2F, as gitlab.arbisoft.com's does) re-addresses it by numeric id.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './outbox.mjs';

const require = createRequire(import.meta.url);
const { readEnv, repoFromEnv, isPlaceholder } = require('../../src/lib/repourl.cjs');

const TIMEOUT_MS = 15_000;
const DESK_TOKEN_FILE = join(homedir(), '.config', 'oneshot', 'gitlab-token');

function deskFileToken() {
  try {
    const line = readFileSync(DESK_TOKEN_FILE, 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return line && !isPlaceholder(line) ? line : '';
  } catch { return ''; }
}

/** `{ apiUrl, project, token }`, or `{ error }` naming what is missing. Never prints the token. */
export function gitlabTarget(env = process.env) {
  const { repo, error } = repoFromEnv(env);
  if (!repo) return { error: `GITLAB_REPO_URL unusable: ${error}` };
  const token = readEnv(env, 'GITLAB_READ_TOKEN') || readEnv(env, 'ONESHOT_GITLAB_TOKEN')
    || (env === process.env ? deskFileToken() : '') || readEnv(env, 'GITLAB_TOKEN');
  if (!token) return { error: 'no GitLab token (GITLAB_READ_TOKEN, ONESHOT_GITLAB_TOKEN or GITLAB_TOKEN)' };
  return { apiUrl: repo.apiUrl, project: repo.project, token };
}

/** apiUrl|project → numeric id, once a route-404 proved the path form unusable. */
const ids = new Map();

/** `{"error":"404 Not Found"}` is GitLab matching no route; `{"message":…}` is a missing resource. */
const routeMissing = (body) => /"error"\s*:\s*"404 Not Found"/.test(body);

/**
 * GET `/projects/<project><suffix>` — by path, or by numeric id when the path form is
 * not routed. The id comes from an EXACT path_with_namespace match among the token's
 * projects, never a near one. Resolves to the fetch Response (or a 404 stand-in); throws
 * only what fetch throws.
 */
export async function getProject(t, suffix, { fetch: f = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const get = (path) => f(`${t.apiUrl}${path}`, { headers: { 'PRIVATE-TOKEN': t.token }, signal: AbortSignal.timeout(timeoutMs) });
  const key = `${t.apiUrl}|${t.project}`;
  if (ids.has(key)) return get(`/projects/${ids.get(key)}${suffix}`);
  const res = await get(`/projects/${encodeURIComponent(t.project)}${suffix}`);
  if (res.status !== 404) return res;
  if (!routeMissing(await res.text().catch(() => ''))) return { ok: false, status: 404 };
  const leaf = t.project.slice(t.project.lastIndexOf('/') + 1);
  const found = await get(`/projects?search=${encodeURIComponent(leaf)}&simple=true&membership=true&per_page=100`);
  const list = found.ok ? await found.json().catch(() => null) : null;
  const hit = Array.isArray(list) ? list.find((p) => p?.path_with_namespace === t.project) : null;
  if (!hit) return { ok: false, status: 404 };
  ids.set(key, hit.id);
  return get(`/projects/${hit.id}${suffix}`);
}

/** The numeric id getProject fell back to for this target, or undefined while the path form works. */
export const fallbackId = (t) => ids.get(`${t.apiUrl}|${t.project}`);

let warned = false;

/** The GitLab username that merged MR `mrIid`, or null — on any failure, never a throw. */
export async function mergedBy(mrIid, { fetch: f = globalThis.fetch, env = process.env } = {}) {
  const t = gitlabTarget(env);
  if (t.error) {
    if (!warned) { warned = true; console.log(`${new Date().toISOString()} merge answerer off — ${t.error}`); }
    return null;
  }
  try {
    const res = await getProject(t, `/merge_requests/${mrIid}`, { fetch: f });
    if (!res.ok) return null;
    const mr = await res.json();
    return mr?.merge_user?.username ?? mr?.merged_by?.username ?? null;
  } catch { return null; }
}

/**
 * run_id → merger username, persisted. `get` returns undefined for a run never
 * looked up and null for one looked up whose answer was unknown.
 */
export function mergerCache(stateDir) {
  const file = join(stateDir, 'mergers.json');
  let map = {};
  if (existsSync(file)) {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j && typeof j === 'object') map = j; } catch { /* start fresh */ }
  }
  return {
    get: (runId) => (Object.hasOwn(map, runId) ? map[runId] : undefined),
    set: (runId, name) => { map[runId] = name ?? null; },
    save: () => { try { atomicWrite(file, JSON.stringify(map)); } catch { /* best effort */ } },
  };
}
