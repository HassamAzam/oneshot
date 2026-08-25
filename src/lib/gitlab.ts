/**
 * GitLab REST helpers used by the conductor itself. Phase sessions talk to
 * GitLab through the MCP server instead; this is the code path, and it is the
 * only one that performs label writes, merges and promotions.
 *
 * Every call classifies its failure, because "the VPN is down" and "your token
 * is wrong" and "that issue does not exist" demand completely different
 * responses, and a caller that blurs them retries forever against a dead link.
 */
import { envOr, projectConfig, DRY_RUN } from './config.js';
import { log } from './log.js';

export type FailKind = 'ok' | 'network' | 'auth' | 'notfound' | 'server' | 'client';

export interface GitlabResult<T> {
  ok: boolean;
  kind: FailKind;
  status: number;
  data: T | null;
  error?: string;
}

function token(): string {
  const t = envOr('GITLAB_READ_TOKEN') || envOr('GITLAB_TOKEN');
  if (!t) throw new Error('Neither GITLAB_READ_TOKEN nor GITLAB_TOKEN is set — put one in .env');
  return t;
}

function writeToken(): string {
  const t = envOr('GITLAB_TOKEN');
  if (!t) throw new Error('GITLAB_TOKEN is not set — put it in .env');
  return t;
}

function base(): string { return projectConfig().gitlab.apiUrl; }
function projectId(): number { return projectConfig().gitlab.projectId; }

/**
 * Classify a failure. 5xx counts as "network" for circuit-breaker purposes:
 * GitLab answering 500, or a captive portal answering for it, means work
 * cannot proceed either way. 401/403 deliberately does NOT — the server
 * answered, so a bad token must not look like an outage.
 */
function classify(status: number): FailKind {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status >= 500) return 'server';
  return 'client';
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  useWriteToken = false,
): Promise<GitlabResult<T>> {
  const url = `${base()}${path}`;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': useWriteToken ? writeToken() : token(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const kind = classify(res.status);
    if (kind !== 'ok') {
      const text = await res.text().catch(() => '');
      return { ok: false, kind, status: res.status, data: null, error: text.slice(0, 300) };
    }
    return { ok: true, kind: 'ok', status: res.status, data: (await res.json()) as T };
  } catch (err) {
    // Timeout, DNS failure, connection refused — the VPN case.
    return {
      ok: false, kind: 'network', status: 0, data: null,
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    clearTimeout(killer);
  }
}

export interface Issue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  state: string;
  web_url: string;
  updated_at: string;
}

export function getIssue(iid: number): Promise<GitlabResult<Issue>> {
  return call<Issue>('GET', `/projects/${projectId()}/issues/${iid}`);
}

/** Open issues carrying the entry label, oldest-updated first (rough FIFO). */
export async function issuesWithEntryLabel(): Promise<GitlabResult<Issue[]>> {
  const label = encodeURIComponent(projectConfig().labels.entry);
  return call<Issue[]>(
    'GET',
    `/projects/${projectId()}/issues?state=opened&labels=${label}&per_page=50&order_by=updated_at&sort=asc`,
  );
}

export function issueNotes(iid: number): Promise<GitlabResult<Array<{ id: number; body: string }>>> {
  return call('GET', `/projects/${projectId()}/issues/${iid}/notes?per_page=100`);
}

export async function addIssueNote(iid: number, body: string): Promise<GitlabResult<unknown>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would add note to #${iid}`, { chars: body.length });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call('POST', `/projects/${projectId()}/issues/${iid}/notes`, { body }, true);
}

/**
 * Swap the ticket's Oneshot label, preserving every other label.
 *
 * GitLab's `labels` field is a full replacement, so anything not carried
 * through here is silently dropped — which is exactly how a board loses its
 * Minor/Major/AI markers. Callers pass what to remove and what to add; the
 * rest of the array is copied unchanged.
 */
export async function swapLabel(
  iid: number,
  remove: string[],
  add: string[],
): Promise<GitlabResult<Issue>> {
  const current = await getIssue(iid);
  if (!current.ok || !current.data) return current;

  const removeSet = new Set(remove);
  const next = current.data.labels.filter((l) => !removeSet.has(l));
  for (const l of add) if (!next.includes(l)) next.push(l);

  if (DRY_RUN) {
    log.warn(`[dry-run] would set labels on #${iid}`, { from: current.data.labels, to: next });
    return { ok: true, kind: 'ok', status: 200, data: current.data };
  }
  return call<Issue>(
    'PUT', `/projects/${projectId()}/issues/${iid}`, { labels: next.join(',') }, true,
  );
}

export interface Branch { name: string; protected: boolean; commit: { id: string } }

export function listBranches(): Promise<GitlabResult<Branch[]>> {
  return call<Branch[]>('GET', `/projects/${projectId()}/repository/branches?per_page=100`);
}

export function getBranch(name: string): Promise<GitlabResult<Branch>> {
  return call<Branch>(
    'GET', `/projects/${projectId()}/repository/branches/${encodeURIComponent(name)}`,
  );
}

/** Cheapest possible authenticated call — the reachability probe. */
export async function ping(): Promise<GitlabResult<{ id: number }>> {
  return call<{ id: number }>('GET', `/projects/${projectId()}?statistics=false`);
}

export function projectUrl(): string {
  const c = projectConfig();
  return `https://${c.gitlab.host}/${c.gitlab.project}`;
}

export function issueUrl(iid: number): string {
  return `${projectUrl()}/-/issues/${iid}`;
}
