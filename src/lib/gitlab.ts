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

/**
 * A ticket's comments, OLDEST FIRST — but only the NEWEST hundred of them.
 *
 * The ordering matters and the direction is a trap. Every caller keeps a
 * bounded tail (`.slice(-25)`, the close-note marker scan) on the assumption
 * that the tail is the recent end. `sort=asc` seems to buy that, but GitLab
 * caps `per_page` at 100 and this makes ONE request with no pagination, so on a
 * ticket with more than 100 comments `sort=asc` returns page one — the OLDEST
 * hundred — and the recent comments are never fetched at all. The research
 * phase would read the opening chatter and miss criteria amended last week, and
 * a just-posted close marker would fall outside the scanned set and be
 * re-posted on resume.
 *
 * So fetch newest-first to get the genuinely recent hundred, then reverse to
 * hand callers the oldest-first order their `.slice(-25)` expects.
 *
 * `system` is GitLab's own flag for a note it generated itself — a label
 * change, an assignment, a "marked this issue as related to" — as opposed to
 * one a person typed. Carried through (optional, since it is new and older
 * callers never asked for it) so a caller distinguishing human replies from
 * board noise — the review-gate poll in src/conductor/reviewgate.ts — does not
 * have to guess from body text alone.
 */
export async function issueNotes(
  iid: number,
): Promise<GitlabResult<Array<{ id: number; body: string; system?: boolean }>>> {
  const res = await call<Array<{ id: number; body: string; system?: boolean }>>(
    'GET',
    `/projects/${projectId()}/issues/${iid}/notes?per_page=100&order_by=created_at&sort=desc`,
  );
  if (res.ok && res.data) return { ...res, data: [...res.data].reverse() };
  return res;
}

export async function addIssueNote(
  iid: number, body: string,
): Promise<GitlabResult<{ id: number }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would add note to #${iid}`, { chars: body.length });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<{ id: number }>(
    'POST', `/projects/${projectId()}/issues/${iid}/notes`, { body }, true,
  );
}

export interface Upload {
  url: string;
  markdown: string;
  full_path?: string;
}

/**
 * Attach a file to the project and get back the markdown that renders it.
 *
 * Multipart, so it cannot go through call() — and deliberately so: the JSON
 * helper sets its own Content-Type, while a multipart body needs fetch to
 * generate the boundary, which it only does when the header is ABSENT.
 *
 * The returned `markdown` is project-scoped: it renders in a note on this
 * project's issues or merge requests and nowhere else, which is exactly the
 * scope Oneshot posts into.
 */
export async function uploadFile(
  filename: string, content: Buffer | string, mime = 'application/octet-stream',
): Promise<GitlabResult<Upload>> {
  if (DRY_RUN) {
    log.warn('[dry-run] would upload', { filename, bytes: content.length });
    return {
      ok: true, kind: 'ok', status: 200,
      data: { url: '', markdown: `_(dry-run: ${filename} not uploaded)_` },
    };
  }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);

  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${base()}/projects/${projectId()}/uploads`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': writeToken() },
      body: form,
      signal: controller.signal,
    });
    const kind = classify(res.status);
    if (kind !== 'ok') {
      const text = await res.text().catch(() => '');
      return { ok: false, kind, status: res.status, data: null, error: text.slice(0, 300) };
    }
    return { ok: true, kind: 'ok', status: res.status, data: (await res.json()) as Upload };
  } catch (err) {
    return {
      ok: false, kind: 'network', status: 0, data: null,
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    clearTimeout(killer);
  }
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

// ------------------------------------------------------------ merge requests

export type MergeState = 'opened' | 'closed' | 'locked' | 'merged';

/**
 * GitLab 15.6+. Older instances omit the field entirely, which is why every
 * caller must be able to fall back to `merge_status` + `has_conflicts`, and why
 * the union stays open: a status this code has never seen must survive the
 * round-trip so the caller can echo it rather than silently treat it as
 * mergeable.
 */
export type DetailedMergeStatus =
  | 'mergeable' | 'unchecked' | 'checking' | 'preparing' | 'approvals_syncing'
  | 'ci_must_pass' | 'ci_still_running' | 'conflict' | 'need_rebase'
  | 'discussions_not_resolved' | 'draft_status' | 'not_open' | 'not_approved'
  | 'requested_changes' | 'blocked_status' | 'broken_status' | 'commits_status'
  | 'status_checks_must_pass' | 'jira_association_missing'
  | 'security_policy_violations' | 'locked_paths' | 'locked_lfs_files'
  | (string & {});

export interface MergeRequest {
  iid: number;
  id: number;
  project_id: number;
  state: MergeState;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  /** Head of the source branch as GitLab last saw it — the accept guard. */
  sha: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  merge_status: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking'
    | 'cannot_be_merged_recheck';
  detailed_merge_status?: DetailedMergeStatus;
  has_conflicts: boolean;
  merge_error: string | null;
  draft: boolean;
  squash: boolean;
  blocking_discussions_resolved: boolean;
  /** Only present with include_rebase_in_progress=true. */
  rebase_in_progress?: boolean;
  head_pipeline?: { id: number; status: string; web_url: string } | null;
  diverged_commits_count?: number;
}

export interface ProjectSettings {
  merge_method: 'merge' | 'rebase_merge' | 'ff';
  squash_option: 'never' | 'always' | 'default_on' | 'default_off';
  only_allow_merge_if_pipeline_succeeds: boolean;
  only_allow_merge_if_all_discussions_are_resolved: boolean;
  allow_merge_on_skipped_pipeline: boolean;
  merge_requests_enabled: boolean;
}

/**
 * One merge request, in full.
 *
 * `include_rebase_in_progress` costs a Gitaly round-trip, so it is opt-in and
 * asked for only while a rebase is actually being waited on.
 */
export function getMergeRequest(
  mrIid: number,
  opts: { rebaseProgress?: boolean; divergedCount?: boolean } = {},
): Promise<GitlabResult<MergeRequest>> {
  const params: string[] = [];
  if (opts.rebaseProgress) params.push('include_rebase_in_progress=true');
  if (opts.divergedCount) params.push('include_diverged_commits_count=true');
  const q = params.length ? `?${params.join('&')}` : '';
  return call<MergeRequest>('GET', `/projects/${projectId()}/merge_requests/${mrIid}${q}`);
}

/**
 * Discover merge requests by branch, newest-updated first.
 *
 * The list endpoint omits merge_status, detailed_merge_status and diff_refs, so
 * this answers "which iid" and nothing else — read the iid back through
 * getMergeRequest() before deciding anything about mergeability.
 */
export function findMergeRequests(q: {
  sourceBranch?: string;
  targetBranch?: string;
  state?: 'opened' | 'merged' | 'closed' | 'all';
}): Promise<GitlabResult<MergeRequest[]>> {
  const params = ['order_by=updated_at', 'sort=desc', 'per_page=20',
    `state=${q.state ?? 'opened'}`];
  if (q.sourceBranch) params.push(`source_branch=${encodeURIComponent(q.sourceBranch)}`);
  if (q.targetBranch) params.push(`target_branch=${encodeURIComponent(q.targetBranch)}`);
  return call<MergeRequest[]>(
    'GET', `/projects/${projectId()}/merge_requests?${params.join('&')}`,
  );
}

export function mrDiscussions(mrIid: number): Promise<GitlabResult<Array<{
  id: string;
  notes: Array<{
    id: number; body: string; resolvable: boolean; resolved: boolean;
    author: { username: string };
  }>;
}>>> {
  return call('GET', `/projects/${projectId()}/merge_requests/${mrIid}/discussions?per_page=100`);
}

/** What a comparison actually tells us, with the payload that can be megabytes left behind. */
export interface RefComparison {
  /** Commits present in `to` and absent from `from`. Zero means fully contained. */
  commits: number;
  /** Short shas, capped — enough to name the work, never enough to bloat a log. */
  shas: string[];
  sameRef: boolean;
}

const COMPARE_SHAS_KEPT = 10;

/**
 * Containment test between two refs.
 *
 * `compareRefs(to, from)` returning zero commits means `to` already contains
 * every commit of `from`, which is the correct promotion skip: it stays true
 * when the target is legitimately AHEAD of the source, where sha equality would
 * wrongly report work to promote and open an empty MR on every run.
 *
 * The response's `diffs` array is deliberately dropped rather than trimmed — it
 * carries full patch text for every changed file and has no business in an
 * artifact or a log line.
 */
export async function compareRefs(
  from: string, to: string, straight = true,
): Promise<GitlabResult<RefComparison>> {
  const res = await call<{
    commits?: Array<{ id: string }>;
    compare_same_ref?: boolean;
  }>(
    'GET',
    `/projects/${projectId()}/repository/compare` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=${straight}`,
  );
  if (!res.ok || !res.data) return { ...res, data: null };
  const commits = res.data.commits ?? [];
  return {
    ...res,
    data: {
      commits: commits.length,
      shas: commits.slice(0, COMPARE_SHAS_KEPT).map((c) => c.id.slice(0, 8)),
      sameRef: res.data.compare_same_ref === true,
    },
  };
}

/**
 * The project's merge policy.
 *
 * Deliberately not folded into ping(): ping is the circuit breaker's probe and
 * has to stay the cheapest, dumbest call in the file.
 */
export function projectSettings(): Promise<GitlabResult<ProjectSettings>> {
  return call<ProjectSettings>('GET', `/projects/${projectId()}`);
}

/** Named failures for a BLOCKED message. Never called from a poll loop. */
export function failedJobs(pipelineId: number): Promise<GitlabResult<Array<{
  id: number; name: string; stage: string; web_url: string;
}>>> {
  return call(
    'GET',
    `/projects/${projectId()}/pipelines/${pipelineId}/jobs?scope%5B%5D=failed&per_page=20`,
  );
}

/**
 * Merge one merge request.
 *
 * `sha` is optional to GitLab and mandatory here: it pins the merge to the head
 * this caller actually evaluated, so a branch that moved under us fails loudly
 * with a 409 instead of quietly merging code nobody looked at.
 *
 * `merge_when_pipeline_succeeds` is deliberately not exposed. It returns 200
 * immediately with the MR still open, which would let the pipeline report a
 * merge that has not happened and deploy a base branch without the change in it.
 */
export async function acceptMergeRequest(mrIid: number, opts: {
  sha: string;
  squash: boolean;
  removeSourceBranch?: boolean;
  mergeCommitMessage?: string;
  squashCommitMessage?: string;
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would merge !${mrIid}`, { sha: opts.sha.slice(0, 8), squash: opts.squash });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<MergeRequest>('PUT', `/projects/${projectId()}/merge_requests/${mrIid}/merge`, {
    sha: opts.sha,
    squash: opts.squash,
    should_remove_source_branch: opts.removeSourceBranch === true,
    ...(opts.mergeCommitMessage ? { merge_commit_message: opts.mergeCommitMessage } : {}),
    ...(opts.squashCommitMessage ? { squash_commit_message: opts.squashCommitMessage } : {}),
  }, true);
}

/** Returns 202 and rebases asynchronously — poll rebase_in_progress, never re-issue. */
export async function rebaseMergeRequest(
  mrIid: number, skipCi = false,
): Promise<GitlabResult<{ rebase_in_progress: boolean }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would rebase !${mrIid}`);
    return { ok: true, kind: 'ok', status: 202, data: null };
  }
  return call<{ rebase_in_progress: boolean }>(
    'PUT',
    `/projects/${projectId()}/merge_requests/${mrIid}/rebase${skipCi ? '?skip_ci=true' : ''}`,
    undefined,
    true,
  );
}

export async function createMergeRequest(opts: {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  removeSourceBranch?: boolean;
  labels?: string[];
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn('[dry-run] would open a merge request', {
      from: opts.sourceBranch, to: opts.targetBranch, title: opts.title,
    });
    return { ok: true, kind: 'ok', status: 201, data: null };
  }
  return call<MergeRequest>('POST', `/projects/${projectId()}/merge_requests`, {
    source_branch: opts.sourceBranch,
    target_branch: opts.targetBranch,
    title: opts.title,
    description: opts.description,
    remove_source_branch: opts.removeSourceBranch === true,
    ...(opts.labels?.length ? { labels: opts.labels.join(',') } : {}),
  }, true);
}

export async function updateMergeRequest(mrIid: number, patch: {
  title?: string;
  description?: string;
  targetBranch?: string;
  stateEvent?: 'close' | 'reopen';
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would update !${mrIid}`, { fields: Object.keys(patch) });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<MergeRequest>('PUT', `/projects/${projectId()}/merge_requests/${mrIid}`, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.targetBranch === undefined ? {} : { target_branch: patch.targetBranch }),
    ...(patch.stateEvent === undefined ? {} : { state_event: patch.stateEvent }),
  }, true);
}

export async function addMergeRequestNote(
  mrIid: number, body: string,
): Promise<GitlabResult<{ id: number }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would add note to !${mrIid}`, { chars: body.length });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<{ id: number }>(
    'POST', `/projects/${projectId()}/merge_requests/${mrIid}/notes`, { body }, true,
  );
}

/**
 * Why a merge write was refused, at the resolution a caller can act on.
 *
 * A sibling of classify() rather than an extension of FailKind: the
 * reachability breaker decides "is the VPN down" from `network`/`server`, so a
 * merge-specific kind leaking into FailKind would let a refused merge trip the
 * network breaker. And classify() calls 405, 406, 409 and 422 all `client`,
 * which is the one distinction that matters here — "your sha is stale, re-read
 * and retry" and "this thing has conflicts" demand opposite responses.
 */
export type MergeRefusal =
  | 'sha-stale'
  | 'not-mergeable'
  | 'squash-policy'
  | 'rebase-running'
  | 'duplicate-mr'
  | 'auth'
  | 'network'
  | 'other';

export function mergeRefusal(res: GitlabResult<unknown>): MergeRefusal {
  if (res.kind === 'auth') return 'auth';
  if (res.kind === 'network' || res.kind === 'server') return 'network';
  const body = (res.error ?? '').toLowerCase();
  if (res.status === 409 && /already exists/.test(body)) return 'duplicate-mr';
  if (res.status === 409 && /rebase/.test(body)) return 'rebase-running';
  if (res.status === 409) return 'sha-stale';
  if (res.status === 422 && /squash/.test(body)) return 'squash-policy';
  if (res.status === 405 || res.status === 406) return 'not-mergeable';
  return 'other';
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

export function mergeRequestUrl(mrIid: number): string {
  return `${projectUrl()}/-/merge_requests/${mrIid}`;
}
