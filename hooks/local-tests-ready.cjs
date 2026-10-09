#!/usr/bin/env node
'use strict';
/**
 * The local automation tests mode's readiness check: may Oneshot run this
 * ticket's workstream-automation (Cypress) tests locally yet? Run by the
 * conductor (src/localtests/readiness.ts), never by a session.
 *
 * A ticket is READY only when both hold:
 *   A. `Ready for Automation Testing` is on it — or the operator asked a dry run
 *      to assume it (`--assume-label`, which src/index.ts accepts only with
 *      DRY_RUN=1, so a rehearsal can be run on any merged ticket);
 *   B. the ticket's change is MERGED into the base branch (branches.base,
 *      `dev`). Only merge requests GitLab links to it (related or closing), in
 *      the same project, that are a real change count — never a branch
 *      promotion or a backmerge (a protected or release source branch, or a
 *      title like `stage -> dev` or `Backmerge …`). Of those, the ticket's OWN
 *      MRs are the ones that close it or name its number in their source
 *      branch or title, in any state. When it has any, only an own MR merged
 *      into the base proves the change: an own MR still open with another
 *      ticket's MR (one that only mentions this one) merged is `not-ready`.
 *      Only when no linked MR closes or names the ticket does any linked MR
 *      merged into the base stand in for it.
 * The latest such merge is the commit the tests run against (`mergedMr`); every
 * own MR merged into the base comes back too, oldest first, as `ranges` — the
 * commit before each change and the commit it left — so the scope can cover a
 * follow-up's earlier MRs as well. `base` is null when the commit before is
 * the merged commit's first parent, which git answers and GitLab does not; a
 * merge that left no merge or squash commit (a fast-forward, or a branch that
 * reached the base by a direct push) has its diff base from GitLab instead, or
 * its head's first parent covers only its last commit.
 * Labelled but not merged is `not-ready`, which the runner waits on quietly and
 * checks again later: a merge does not touch the ticket, so there is nothing
 * to tell anybody yet. Open leftovers, MRs merged into another branch and
 * further merged fixes are warnings, never blockers.
 *
 * NOT A HOOK, though it lives here beside hooks/automation-ready.cjs for the
 * same reasons: dependency-free CJS, the shared _common.cjs, and a pure
 * decision function the tests reach with createRequire. No event registers it
 * (src/conductor/hooks.ts); its only caller spawns it before the mode spends a
 * scope session.
 *
 * It never says `ready` without proof. A missing token, GitLab down, a 500, an
 * unexpected shape or a bug in this file all answer `unknown` with the reason,
 * and the runner holds on `unknown`. What it cannot catch (not running at all,
 * printing nothing or garbage) the runner reads as `unknown` too.
 *
 * Output: exactly one JSON object on stdout, exit 0, with the verdict under
 * `localTestsReadiness`; anything short of `ready` also carries the guard
 * contract's `{ decision: 'block', reason }`.
 *
 * Inputs arrive in THIS process's environment only, never a session's:
 * ONESHOT_TICKET, ONESHOT_LOCAL_TESTS_API, ONESHOT_LOCAL_TESTS_PROJECT and
 * ONESHOT_LOCAL_TESTS_TOKEN (sent as a header, never printed, logged or put in
 * a URL), plus the policy the conductor already resolved —
 * ONESHOT_LOCAL_TESTS_TRIGGER, _BASE, _PROTECTED (JSON) and _RELEASE (a regex
 * source) — each falling back to config/project.json, and
 * ONESHOT_LOCAL_TESTS_ASSUME_LABEL=1.
 *
 * Module shape: this file only defines and exports functions; every network
 * call and exit lives in main(), which runs only when the file is executed.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

/** One deadline for every GitLab call, under the conductor's 30s kill, so the answer is always structured. */
const DEADLINE_MS = 20_000;
/** Per request, so one stuck call cannot use the whole deadline by itself. */
const REQUEST_MS = 8_000;
const PER_PAGE = 100;

/**
 * Titles of MRs that carry a branch to another branch rather than fix
 * anything: `stage -> dev`, `master → stage`, `dev into stage`, `Backmerge …`.
 * The source branch catches most promotions; the title catches the ones cut
 * from a short-lived branch of a protected one.
 */
const PROMOTION_TITLE = /\bback[\s-]?merge\b|\b(?:dev|develop|stage|staging|master|main|release|adhoc)\b\s*(?:->|→|=>|>|\binto\b|\bto\b)\s*\b(?:dev|develop|stage|staging|master|main)\b/i;

// ------------------------------------------------------------------ helpers

/** A thrown failure that already knows its errorKind. */
class ReadyError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const sha7 = (s) => String(s || '').slice(0, 7);

/** A commit id as GitLab gives one. Anything else is never passed on: the runner hands these to git. */
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{7,64}$/i.test(s);

/**
 * True when `mr` carries one branch into another instead of fixing the ticket:
 * its source is a protected branch (exact name) or a release branch, or its
 * title reads like a promotion or a backmerge.
 */
function isPromotion(mr, protectedBranches, releaseBranch) {
  const source = String((mr && mr.source_branch) || '');
  if (protectedBranches.includes(source)) return true;
  if (releaseBranch) {
    releaseBranch.lastIndex = 0;
    if (releaseBranch.test(source)) return true;
  }
  return PROMOTION_TITLE.test(String((mr && mr.title) || ''));
}

/**
 * The commit a merged MR put on its target: the merge commit, else the squash
 * commit (a squash merge without one), else the head (a fast-forward). '' when
 * GitLab names none.
 */
function mergeShaOf(mr) {
  for (const k of ['merge_commit_sha', 'squash_commit_sha', 'sha']) {
    if (mr && isSha(mr[k])) return mr[k];
  }
  return '';
}

/**
 * The commit before a merged MR's change, when GitLab knows it and git does
 * not. A merge commit's first parent, and a squash commit's, is the base as it
 * was just before the merge — the runner reads it as `<commit>^1`, so null. A
 * merge that left neither (a fast-forward, or a branch that reached the base
 * by a direct push) is tested at the MR's head, whose first parent is only the
 * MR's own previous commit; there the base is GitLab's diff base
 * (`diff_refs.base_sha`, on the full MR only). Null when that is missing too.
 */
function baseOf(mr) {
  if (!mr || isSha(mr.merge_commit_sha) || isSha(mr.squash_commit_sha)) return null;
  const refs = mr.diff_refs && typeof mr.diff_refs === 'object' ? mr.diff_refs : null;
  const base = refs ? refs.base_sha : null;
  return isSha(base) && base !== mergeShaOf(mr) ? base : null;
}

/**
 * Related and closing MRs as one list, each MR once. An MR on the closing list
 * says it closes this ticket (`Closes #N`), which is marked `closesIssue`: it
 * is the ticket's own change by its author's word, not one that only mentions it.
 */
function mergeLinked(related, closing) {
  const out = new Map();
  for (const m of Array.isArray(related) ? related : []) {
    if (m && Number.isInteger(m.iid)) out.set(`${m.project_id}:${m.iid}`, m);
  }
  for (const m of Array.isArray(closing) ? closing : []) {
    if (m && Number.isInteger(m.iid)) out.set(`${m.project_id}:${m.iid}`, { ...m, closesIssue: true });
  }
  return [...out.values()];
}

/**
 * Which linked MR is the change under test. Pure. Same project only; a
 * promotion never counts. The ticket's OWN MRs — the ones that close it, or
 * whose source branch or title names its number — are decided across every
 * state, because another ticket's MR that says "see also #N" is linked too and
 * may merge first: while the ticket has an own MR, only an own MR merged INTO
 * the base can be its change, and none merged yet is a wait, never a fallback.
 * Only a ticket with no own MR at all falls back to any linked MR merged into
 * the base (a branch named after something else, a title that never says the
 * number). The latest merge in the pool wins: it is the newest code. `ranged`
 * is what the runner scopes, oldest first: every own MR merged into the base,
 * or, in the fallback, the chosen MR alone.
 */
function chooseMerged(f) {
  const { issue, base, protectedBranches, releaseBranch } = f;
  const mrs = Array.isArray(f.mrs) ? f.mrs : [];
  const same = mrs.filter((m) => m && (m.project_id === undefined || m.project_id === issue.project_id));
  const promotions = same.filter((m) => isPromotion(m, protectedBranches, releaseBranch));
  const real = same.filter((m) => !isPromotion(m, protectedBranches, releaseBranch));
  const time = (m) => Date.parse(m.merged_at) || 0;
  const intoBase = real.filter((m) => m.state === 'merged' && m.target_branch === base)
    .sort((a, b) => time(a) - time(b) || a.iid - b.iid);
  const elsewhere = real.filter((m) => m.state === 'merged' && m.target_branch !== base);
  const open = real.filter((m) => m.state === 'opened').sort((a, b) => a.iid - b.iid);
  const names = new RegExp(`(^|[^0-9])${Number(issue.iid)}([^0-9]|$)`);
  const isOwn = (m) => m.closesIssue === true || names.test(`${m.source_branch || ''} ${m.title || ''}`);
  const own = real.filter(isOwn).sort((a, b) => a.iid - b.iid);
  const fallback = own.length === 0;
  const pool = fallback ? intoBase : intoBase.filter(isOwn);
  const chosen = pool[pool.length - 1] || null;
  const ranged = fallback ? (chosen ? [chosen] : []) : pool;
  return { same, promotions, real, intoBase, elsewhere, open, own, fallback, pool, ranged, chosen, isOwn };
}

/** One merged MR as the runner scopes it: the commit before its change (null: the commit's first parent) and the commit it left. */
function rangeOf(mr) {
  return { mrIid: mr.iid, base: baseOf(mr), head: mergeShaOf(mr) };
}

/** `!12 is still open`, `!13 was merged into stage`, … one per MR, by number. */
function describeStates(list) {
  return [...list].sort((a, b) => a.iid - b.iid).map((m) => (m.state === 'merged'
    ? `!${m.iid} was merged into ${m.target_branch}`
    : `!${m.iid} ${m.state === 'opened' ? 'is still open' : m.state === 'closed' ? 'was closed without merging' : `is ${m.state}`}`));
}

const listIids = (list) => list.map((m) => `!${m.iid}`).join(', ');

/**
 * Judge one ticket. Pure: every input is passed in, nothing is read.
 * Returns the LocalTestsReadiness shape declared in src/localtests/readiness.ts.
 */
function decideReadiness(f) {
  const { issue, trigger, base } = f;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const labelled = Boolean(f.assumeLabel) || labels.includes(trigger);
  const c = chooseMerged(f);
  const warnings = [];
  const reasons = [];

  if (!labelled) reasons.push(`"${trigger}" is not on the ticket`);

  let mergedMr = null;
  const chosen = c.chosen;
  if (chosen) {
    const mergeSha = mergeShaOf(chosen);
    if (!mergeSha) {
      reasons.push(`!${chosen.iid} is merged into ${base}, but GitLab names no commit for it`);
    } else {
      // Every scoped merge, oldest first; one GitLab names no commit for cannot be scoped.
      const ranges = [];
      for (const m of c.ranged) {
        const r = rangeOf(m);
        if (r.head) ranges.push(r);
        else warnings.push(`!${m.iid} is merged into ${base}, but GitLab names no commit for it, so its change is not scoped`);
      }
      const tested = rangeOf(chosen);
      mergedMr = {
        iid: chosen.iid,
        title: typeof chosen.title === 'string' ? chosen.title : '',
        mergeSha,
        base: tested.base,
        sourceBranch: String(chosen.source_branch || ''),
        targetBranch: String(chosen.target_branch || ''),
        author: chosen.author && typeof chosen.author.username === 'string' ? chosen.author.username : null,
        mergedAt: typeof chosen.merged_at === 'string' ? chosen.merged_at : null,
        url: typeof chosen.web_url === 'string' ? chosen.web_url : '',
        ranges,
      };
      if (!isSha(chosen.merge_commit_sha)) {
        warnings.push(isSha(chosen.squash_commit_sha)
          ? `!${chosen.iid} has no merge commit (a squash merge), so its squash commit ${sha7(mergeSha)} is tested`
          : `!${chosen.iid} has no merge commit (a fast-forward merge, or its branch reached ${base} by a direct push), `
            + `so its head commit ${sha7(mergeSha)} is tested, ${tested.base
              ? `against its diff base ${sha7(tested.base)}`
              : 'and GitLab gave no diff base: only its last commit is scoped'}`);
      }
    }
    for (const m of c.ranged) {
      if (m !== chosen && !isSha(m.merge_commit_sha) && !isSha(m.squash_commit_sha) && !baseOf(m) && mergeShaOf(m)) {
        warnings.push(`!${m.iid} has no merge commit and GitLab gave no diff base, so only its last commit is scoped`);
      }
    }
    const earlier = c.pool.filter((m) => m !== chosen);
    if (c.fallback) {
      warnings.push(`nothing linked closes or names #${issue.iid}, so !${chosen.iid}, the latest linked merge into ${base}, `
        + `is taken as its change${earlier.length ? ` (${listIids(earlier)} also merged into ${base})` : ''}`);
    } else {
      if (earlier.length) {
        warnings.push(`${listIids(earlier)} also merged into ${base}; !${chosen.iid}, the latest of the ticket's own, `
          + `is the commit tested, and all ${c.pool.length} are scoped`);
      }
      const mentions = c.intoBase.filter((m) => !c.isOwn(m));
      if (mentions.length) {
        warnings.push(`${listIids(mentions)} also merged into ${base} but only ${mentions.length === 1 ? 'mentions' : 'mention'} `
          + 'the ticket, so not tested');
      }
    }
    for (const m of c.open) warnings.push(`!${m.iid} is still open — not merged, so not tested`);
    for (const m of c.elsewhere) warnings.push(`!${m.iid} was merged into ${m.target_branch}, not ${base}, so it is not the change tested`);
  } else if (c.real.length === 0 && c.promotions.length) {
    const hops = [...new Set(c.promotions.map((m) => `${m.source_branch} → ${m.target_branch}`))];
    reasons.push(`no merge request is linked to this ticket — only branch promotions (${hops.slice(0, 3).join(', ')}`
      + `${hops.length > 3 ? ' …' : ''}) mention it`);
  } else if (c.real.length === 0) {
    reasons.push('no merge request is linked to this ticket');
  } else if (!c.fallback && c.intoBase.length) {
    // The ticket's own MR is not merged, but another ticket's MR that mentions it is: that is not its change.
    const one = c.intoBase.length === 1;
    reasons.push(`no merge request of the ticket's own is merged into ${base} yet: ${describeStates(c.own).join('; ')} `
      + `(${listIids(c.intoBase)} ${one ? 'is' : 'are'} merged into ${base} but only ${one ? 'mentions' : 'mention'} the ticket, `
      + `so ${one ? 'it is' : 'they are'} not its change)`);
  } else {
    reasons.push(`no linked merge request is merged into ${base} yet: ${describeStates(c.real).join('; ')}`);
  }

  const ready = reasons.length === 0 && mergedMr !== null;
  return {
    v: 1,
    verdict: ready ? 'ready' : 'not-ready',
    ready,
    iid: issue.iid,
    checkedAt: f.now || new Date().toISOString(),
    issueUpdatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : null,
    labelled,
    reason: ready
      ? `!${mergedMr.iid} (${mergedMr.sourceBranch} → ${mergedMr.targetBranch}) is merged as ${sha7(mergedMr.mergeSha)}`
      : reasons.join('; '),
    mergedMr,
    warnings,
  };
}

/** The verdict for a check that could not be made. The conductor holds on it. */
function unknownReadiness(iid, error, errorKind, now) {
  return {
    v: 1,
    verdict: 'unknown',
    ready: false,
    iid,
    checkedAt: now || new Date().toISOString(),
    issueUpdatedAt: null,
    labelled: false,
    reason: `the readiness check could not be made: ${error}`,
    mergedMr: null,
    warnings: [],
    error,
    errorKind,
  };
}

/** The script's stdout for a verdict. The conductor reads only `localTestsReadiness`. */
function renderOutput(r) {
  if (r.ready) return { localTestsReadiness: r };
  const reason = r.verdict === 'not-ready'
    ? `Not ready for the local automation tests: ${r.reason}.`
    : `Cannot check readiness: ${r.error || 'unknown error'}`;
  return { decision: 'block', reason, localTestsReadiness: r };
}

/** errorKind for an HTTP status GitLab answered with: a bad token must not look like an outage. */
function classifyHttp(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 429 || (status >= 500 && status <= 599)) return 'server';
  return 'other';
}

// ------------------------------------------------------------------- I/O

/** One GET with the token as a header, under the request and overall deadlines. Throws ReadyError. */
async function getJson(url, token, overall, what) {
  const signal = AbortSignal.any([overall, AbortSignal.timeout(REQUEST_MS)]);
  let res;
  try {
    res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' }, signal });
  } catch (err) {
    const why = overall.aborted ? `no answer within ${DEADLINE_MS / 1000}s`
      : signal.aborted ? `no answer within ${REQUEST_MS / 1000}s`
        : (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'fetch failed';
    throw new ReadyError('network', `GitLab could not be reached for ${what} (${why})`);
  }
  if (!res.ok) throw new ReadyError(classifyHttp(res.status), `GitLab answered ${res.status} for ${what}`);
  try {
    return await res.json();
  } catch {
    if (signal.aborted) throw new ReadyError('network', `GitLab stopped answering while sending ${what}`);
    throw new ReadyError('other', `GitLab sent ${what} as something other than JSON`);
  }
}

function asArray(body, what) {
  if (!Array.isArray(body)) throw new ReadyError('other', `GitLab sent ${what} in an unexpected shape`);
  return body;
}

/** Everything the check needs, or the first thing missing. Environment first, config/project.json second. */
function settings() {
  const env = process.env;
  const iid = Number(env.ONESHOT_TICKET);
  const missing = (what) => ({ problem: `${what} is missing`, iid: Number.isInteger(iid) && iid > 0 ? iid : 0 });
  if (!Number.isInteger(iid) || iid <= 0) return missing('the ticket number (ONESHOT_TICKET)');
  if (!env.ONESHOT_LOCAL_TESTS_TOKEN) return missing('the GitLab token (ONESHOT_LOCAL_TESTS_TOKEN)');
  if (!env.ONESHOT_LOCAL_TESTS_API) return missing('the GitLab API URL (ONESHOT_LOCAL_TESTS_API)');
  if (!env.ONESHOT_LOCAL_TESTS_PROJECT) return missing('the GitLab project (ONESHOT_LOCAL_TESTS_PROJECT)');
  const cfg = C.loadConfig('project.json') || {};
  const trigger = env.ONESHOT_LOCAL_TESTS_TRIGGER || (cfg.labels && cfg.labels.localTestsTrigger);
  if (!trigger) return missing('the trigger label (config/project.json labels.localTestsTrigger)');
  const base = env.ONESHOT_LOCAL_TESTS_BASE || (cfg.branches && cfg.branches.base) || 'dev';
  let protectedBranches = cfg.branches && Array.isArray(cfg.branches.protected) ? cfg.branches.protected : null;
  if (env.ONESHOT_LOCAL_TESTS_PROTECTED) {
    try { protectedBranches = JSON.parse(env.ONESHOT_LOCAL_TESTS_PROTECTED); } catch { protectedBranches = null; }
  }
  if (!Array.isArray(protectedBranches)) return missing('the protected branches (config/project.json branches.protected)');
  const releaseSource = env.ONESHOT_LOCAL_TESTS_RELEASE
    || (cfg.automation && typeof cfg.automation.releaseBranchPattern === 'string' ? cfg.automation.releaseBranchPattern : '');
  let releaseBranch = null;
  if (releaseSource) {
    try { releaseBranch = new RegExp(releaseSource, 'i'); } catch { return missing('a valid release branch pattern'); }
  }
  const project = `${env.ONESHOT_LOCAL_TESTS_API.replace(/\/+$/, '')}/projects/${encodeURIComponent(env.ONESHOT_LOCAL_TESTS_PROJECT)}`;
  return {
    iid,
    token: env.ONESHOT_LOCAL_TESTS_TOKEN,
    project,
    issue: `${project}/issues/${iid}`,
    trigger,
    base,
    protectedBranches,
    releaseBranch,
    assumeLabel: env.ONESHOT_LOCAL_TESTS_ASSUME_LABEL === '1',
  };
}

async function check() {
  const s = settings();
  if (s.problem) return unknownReadiness(s.iid, s.problem, 'config');
  const overall = AbortSignal.timeout(DEADLINE_MS);
  try {
    const [issue, related, closing] = await Promise.all([
      getJson(s.issue, s.token, overall, 'the ticket'),
      getJson(`${s.issue}/related_merge_requests?per_page=${PER_PAGE}`, s.token, overall, 'the linked merge requests'),
      // Older GitLab answers 404 here; the related list still names the MR.
      getJson(`${s.issue}/closed_by?per_page=${PER_PAGE}`, s.token, overall, 'the closing merge requests')
        .catch((err) => { if (err instanceof ReadyError && err.kind === 'notfound') return []; throw err; }),
    ]);
    if (!issue || typeof issue !== 'object' || issue.iid !== s.iid) {
      throw new ReadyError('other', 'GitLab sent the ticket in an unexpected shape');
    }
    let mrs = mergeLinked(asArray(related, 'the linked merge requests'), asArray(closing, 'the closing merge requests'));
    const facts = {
      issue, trigger: s.trigger, base: s.base, protectedBranches: s.protectedBranches,
      releaseBranch: s.releaseBranch, assumeLabel: s.assumeLabel,
    };
    // The list endpoints may leave out the merge commit, the author and the
    // diff base; the MR itself names all three. One more GET per merge the
    // runner scopes — the chosen MR and the ticket's earlier own merges — and
    // none for an MR that is not the change.
    const { ranged } = chooseMerged({ ...facts, mrs });
    if (ranged.length) {
      const fulls = await Promise.all(ranged.map((m) => getJson(`${s.project}/merge_requests/${m.iid}`, s.token, overall, `!${m.iid}`)));
      const byMr = new Map();
      ranged.forEach((m, i) => {
        const full = fulls[i];
        if (full && typeof full === 'object' && full.iid === m.iid) byMr.set(m, full);
      });
      mrs = mrs.map((m) => (byMr.has(m) ? { ...m, ...byMr.get(m) } : m));
    }
    return decideReadiness({ ...facts, mrs });
  } catch (err) {
    if (err instanceof ReadyError) return unknownReadiness(s.iid, err.message, err.kind);
    throw err;
  }
}

function finish(out) {
  // Pipes are asynchronous on macOS: exit only once the verdict is written.
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

async function main() {
  let r;
  try {
    r = await check();
  } catch (err) {
    C.logFailure('local-tests-ready', err);
    r = unknownReadiness(Number(process.env.ONESHOT_TICKET) || 0,
      `the readiness check failed (${(err && err.message) || err})`, 'other');
  }
  C.event('local_tests_ready', {
    verdict: r.verdict,
    mr: r.mergedMr ? r.mergedMr.iid : null,
    errorKind: r.errorKind,
  });
  finish(renderOutput(r));
}

module.exports = {
  decideReadiness, chooseMerged, isPromotion, mergeShaOf, baseOf, mergeLinked, renderOutput, unknownReadiness,
  classifyHttp, DEADLINE_MS, PROMOTION_TITLE,
};

if (require.main === module) {
  main().catch((err) => {
    C.logFailure('local-tests-ready main', err);
    finish({ decision: 'block', reason: 'Cannot check readiness: the readiness check failed while answering.' });
  });
}
