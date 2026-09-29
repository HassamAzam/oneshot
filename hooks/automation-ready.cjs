#!/usr/bin/env node
'use strict';
/**
 * UserPromptSubmit: refuse to start an automation-testcases session on a
 * ticket that is not ready for automation test cases.
 *
 * A ticket is READY only when the Loop's entry label is on it and both rules
 * hold:
 *   0. the entry label (`Loop`) is on it. It is the master switch: neither
 *      scan picks up a ticket without it, and `Loop` + the trigger is what
 *      makes a ticket this mode's rather than the Loop pipeline's. Its absence,
 *      like the trigger's, withdraws the request rather than leaving something
 *      to fix, so the runner stops silently on it (src/automation/readiness.ts);
 *   A. the trigger label is on it, and either `Ready For Deployment` was ADDED
 *      before the latest trigger add, or the ticket is closed;
 *   B. at least one merge request GitLab links to it is in the same project,
 *      merged, and a fix rather than a branch promotion (a `stage → dev` MR
 *      that mentions the ticket is not the change that fixed it).
 * Open leftover MRs are a warning, never a blocker: they are not what shipped.
 *
 * THIS GUARD FAILS CLOSED, unlike every other hook in this directory. The
 * others stand between a session and a tool call the pipeline can survive
 * being wrong about; this one stands between a session and the whole of its
 * work, and a session that writes test cases for an unmerged change wastes the
 * session AND puts a wrong list in front of QA. So every failure here — a
 * missing token, GitLab down, a 500, a bug in this file — answers with a
 * block, never with silence. src/conductor/hooks.ts closes the gaps this file
 * cannot (it not running at all, printing nothing, printing garbage).
 *
 * ONE implementation, two callers. The conductor runs this same file through
 * the same runGuard before it spends a session (runAutomationReadyGuard), and
 * reads the machine verdict from the extra `automationReadiness` key. That
 * pre-run is the hard gate; the in-session copy is the second line.
 *
 * Output (exactly one JSON object on stdout, exit 0):
 *   ready      → hookSpecificOutput.additionalContext names the merged MRs
 *   not-ready  → { decision: 'block', reason }
 *   cannot say → { decision: 'block', reason }
 * A block is `decision:'block'` ALONE. Adding `continue:false` makes the CLI
 * keep the user message and report one turn, which hides the block from the
 * conductor's check for a prompt that never reached the model.
 *
 * Module shape: this file only defines and exports functions. Every gate,
 * stdin read, network call and exit lives in main(), which runs only when the
 * file is executed — the unit tests `require` it with no ONESHOT_PHASE, and a
 * top-level bailIfNotOneshot() would end the test process.
 *
 * The token arrives as ONESHOT_AUTOMATION_TOKEN, merged into THIS process's
 * environment only (never the session's). It is sent as a header and never
 * printed, logged or put in a URL.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

/** The on-demand phase this guard serves. src/automation/readiness.ts holds the same string; a test pins them equal. */
const PHASE = 'automation-testcases';

/**
 * One deadline for every GitLab call this script makes. It sits under
 * runGuard's 30s kill (src/conductor/hooks.ts) so the script always answers
 * with a structured `unknown` rather than being killed into a generic
 * "timed out", and runGuard's kill sits under the SDK's 45s matcher timeout.
 */
const DEADLINE_MS = 20_000;
/** Per request, so one stuck call cannot use the whole deadline by itself. */
const REQUEST_MS = 8_000;
/** GitLab's page cap, and the size of a full page of label events. */
const PER_PAGE = 100;
/**
 * Label events come back OLDEST first, so a cap must never quietly cut the
 * tail — that is where the latest trigger add is. Past this many pages the
 * check says `unknown` (and blocks) instead of judging a truncated history.
 */
const MAX_EVENT_PAGES = 10;

// ------------------------------------------------------------------ helpers

/** A thrown failure that already knows its errorKind. */
class ReadyError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * A GitLab timestamp as people on the ticket read it. GitLab already answers
 * in the instance's zone (`…T16:11:43.000+05:00`), so the wall-clock part is
 * kept as given and the offset named, rather than re-zoned to whatever
 * machine this runs on.
 */
function wallClock(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const zone = !m[3] ? '' : m[3] === 'Z' ? ' UTC' : ` UTC${m[3]}`;
  return `${m[1]} ${m[2]}${zone}`;
}

function mrRef(m) {
  return {
    iid: m.iid,
    title: typeof m.title === 'string' ? m.title : '',
    source: m.source_branch,
    target: m.target_branch,
    state: m.state,
    mergedAt: typeof m.merged_at === 'string' ? m.merged_at : null,
    url: typeof m.web_url === 'string' ? m.web_url : '',
  };
}

const STATE_WORDS = {
  opened: 'is still open',
  closed: 'was closed without merging',
  locked: 'is locked',
  merged: 'is merged',
};

// ------------------------------------------------------------ pure decision

/**
 * True when an MR from `branch` is a branch PROMOTION rather than a fix: its
 * source is a protected branch (exact name) or a release branch.
 */
function isPromotionBranch(branch, protectedBranches, releaseBranch) {
  const b = String(branch || '');
  if (protectedBranches.includes(b)) return true;
  releaseBranch.lastIndex = 0;          // harmless for a flagless regex; safe for a /g one
  return releaseBranch.test(b);
}

/**
 * The not-ready fingerprint: the stable FACTS behind each reason (its code and
 * detail), never its wording, in any order. Same facts, same fingerprint, so
 * the same note is never posted twice; a new fact is a new note.
 */
function fingerprint(reasons) {
  const facts = reasons.map((r) => [r.code, r.detail]).sort();
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 12);
}

/**
 * Judge one ticket. Pure: every input is passed in, nothing is read.
 * Returns the Readiness shape declared in src/automation/readiness.ts.
 */
function decideReadiness(f) {
  const { issue, labels, protectedBranches, releaseBranch } = f;
  const events = Array.isArray(f.events) ? f.events : [];
  const mrs = Array.isArray(f.mrs) ? f.mrs : [];
  const issueLabels = Array.isArray(issue.labels) ? issue.labels : [];
  const reasons = [];
  const warnings = [];

  // ---- The master switch. Checked by the hook itself rather than trusted to
  // the scan: a label taken off between the scan and this check, or during the
  // session (this is also its UserPromptSubmit guard), reaches here without
  // one. The rules below are still judged, so the verdict names every fact at
  // once.
  if (!issueLabels.includes(labels.loop)) {
    reasons.push({
      code: 'loop-missing',
      text: `\`${labels.loop}\` is not on the ticket.`,
      fix: `Add \`${labels.loop}\` if this ticket should get automation test cases: the automation mode acts only on tickets that carry it beside \`${labels.trigger}\`.`,
      detail: 'absent',
    });
  }

  // ---- Rule A. Both branches need the trigger label ON the ticket: a closed
  // ticket the label was taken off has withdrawn the request, not finished it.
  const addsOf = (name) => events.filter((e) => e && e.action === 'add' && e.label &&
    e.label.name === name && typeof e.created_at === 'string' && !Number.isNaN(Date.parse(e.created_at)));
  let triggerAt = null;
  for (const e of addsOf(labels.trigger)) {
    if (triggerAt === null || Date.parse(e.created_at) > Date.parse(triggerAt)) triggerAt = e.created_at;
  }
  // "Was added" before the trigger: remove events are ignored, so a label that
  // was removed and re-added still counts from its earlier add. With no trigger
  // add on record at all there is nothing to be before, so any add counts.
  const rfdAdds = addsOf(labels.deployed);
  const rfdBefore = triggerAt === null
    ? rfdAdds.length > 0
    : rfdAdds.some((e) => Date.parse(e.created_at) < Date.parse(triggerAt));
  const present = issueLabels.includes(labels.trigger);

  if (!present) {
    reasons.push({
      code: 'rfa-missing',
      text: `\`${labels.trigger}\` is not on the ticket.`,
      fix: `Add \`${labels.trigger}\` if this ticket should get automation test cases.`,
      detail: 'absent',
    });
  } else if (!(issue.state === 'closed' || rfdBefore)) {
    const when = triggerAt ? ` (${wallClock(triggerAt)})` : '';
    reasons.push({
      code: 'rfd-order',
      text: `\`${labels.deployed}\` was not added before the latest \`${labels.trigger}\`${when}, and the ticket is still open.`,
      fix: `Add \`${labels.deployed}\` once the fix is deployed, then remove and re-add \`${labels.trigger}\` — or close the ticket if it is done.`,
      detail: rfdAdds.length === 0 ? 'absent' : 'after',
    });
  }

  // ---- Rule B. MRs from another project are dropped silently: the ticket's
  // own project is the one the cases are written against.
  const same = mrs.filter((m) => m && m.project_id === issue.project_id);
  const fix = same.filter((m) => !isPromotionBranch(m.source_branch, protectedBranches, releaseBranch));
  const merged = fix.filter((m) => m.state === 'merged')
    .sort((a, b) => (Date.parse(a.merged_at) || 0) - (Date.parse(b.merged_at) || 0));
  const open = fix.filter((m) => m.state === 'opened').sort((a, b) => a.iid - b.iid);

  if (merged.length >= 1) {
    for (const m of open) warnings.push(`!${m.iid} is still open — it is not what shipped, and is ignored`);
  } else {
    const fixText = `Merge the fix MR, or mention \`#${issue.iid}\` in the description of the MR that fixed it so ` +
      'GitLab links it. Oneshot checks again by itself.';
    let text;
    if (fix.length === 0 && same.length > 0) {
      const hops = [...new Set(same.map((m) => `${m.source_branch} → ${m.target_branch}`))];
      const shown = hops.slice(0, 3).join(', ') + (hops.length > 3 ? ' …' : '');
      text = `No merge request is linked to this ticket — only branch-promotion MRs (${shown}) mention it.`;
    } else if (fix.length === 0) {
      text = 'No merge request is linked to this ticket.';
    } else {
      const parts = [...fix].sort((a, b) => a.iid - b.iid)
        .map((m) => `!${m.iid} ${STATE_WORDS[m.state] || `is ${m.state}`}`);
      text = `No linked merge request is merged yet: ${parts.join('; ')}.`;
    }
    reasons.push({
      code: 'mr-not-merged',
      text,
      fix: fixText,
      detail: fix.length ? fix.map((m) => `!${m.iid}:${m.state}`).sort().join(',') : 'none',
    });
  }

  const ready = reasons.length === 0;
  return {
    v: 1,
    verdict: ready ? 'ready' : 'not-ready',
    iid: issue.iid,
    checkedAt: f.now || new Date().toISOString(),
    issueUpdatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : null,
    state: issue.state === 'opened' || issue.state === 'closed' ? issue.state : null,
    triggerAddedAt: triggerAt,
    reasons,
    warnings,
    merged: merged.map(mrRef),
    open: open.map(mrRef),
    fingerprint: ready ? null : fingerprint(reasons),
  };
}

/** The verdict for a check that could not be made. Always blocks. */
function unknownReadiness(iid, error, errorKind, now) {
  return {
    v: 1,
    verdict: 'unknown',
    iid,
    checkedAt: now || new Date().toISOString(),
    issueUpdatedAt: null,
    state: null,
    triggerAddedAt: null,
    reasons: [],
    warnings: [],
    merged: [],
    open: [],
    fingerprint: null,
    error,
    errorKind,
  };
}

/**
 * The hook's stdout for a verdict. Only `ready` lets the prompt through; its
 * context line doubles as the session's list of sources to read. Every other
 * verdict is `decision:'block'` with a string reason and nothing else the CLI
 * reads — no `continue`, no `stopReason` (see the header).
 */
function renderOutput(r) {
  if (r.verdict === 'ready') {
    const merged = r.merged.map((m) => `!${m.iid} (${m.source} → ${m.target})`).join(', ');
    const ignore = r.open.length
      ? ` Ignore ${r.open.map((m) => `!${m.iid}`).join(', ')} (still open).`
      : '';
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Readiness verified by oneshot's automation-ready hook: merged ${merged}.${ignore}`,
      },
      automationReadiness: r,
    };
  }
  const reason = r.verdict === 'not-ready'
    ? `Not ready for automation test cases: ${r.reasons.map((x) => x.text).join(' ')}`
    : `Cannot check readiness: ${r.error || 'unknown error'}`;
  return { decision: 'block', reason: String(reason), automationReadiness: r };
}

/**
 * Which further pages of label events to read, from page 1's X-Total-Pages
 * header and length:
 *   - one page, or page 1 not full              → { pages: [] }
 *   - N pages, 2 ≤ N ≤ MAX_EVENT_PAGES          → { pages: [2..N] }, fetched in parallel
 *   - more than MAX_EVENT_PAGES                 → { tooMany: N }, which is `unknown`
 *   - no header (GitLab omits it on big sets) and page 1 full → { sequential: true }
 */
function labelEventPages(totalPagesHeader, firstPageLength) {
  const total = Number.parseInt(String(totalPagesHeader ?? ''), 10);
  const known = Number.isFinite(total);
  if (firstPageLength < PER_PAGE || (known && total <= 1)) return { pages: [] };
  if (!known) return { sequential: true };
  if (total > MAX_EVENT_PAGES) return { tooMany: total };
  const pages = [];
  for (let p = 2; p <= total; p += 1) pages.push(p);
  return { pages };
}

/**
 * errorKind for an HTTP status GitLab answered with. A bad token must not look
 * like an outage: the runner alerts once on `auth` because waiting never heals
 * it, and simply retries `server`.
 */
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
  if (!res.ok) {
    // The body is not read: it is GitLab's to word, and none of it is needed.
    throw new ReadyError(classifyHttp(res.status), `GitLab answered ${res.status} for ${what}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    if (signal.aborted) throw new ReadyError('network', `GitLab stopped answering while sending ${what}`);
    throw new ReadyError('other', `GitLab sent ${what} as something other than JSON`);
  }
  return { body, headers: res.headers };
}

function asArray(body, what) {
  if (!Array.isArray(body)) throw new ReadyError('other', `GitLab sent ${what} in an unexpected shape`);
  return body;
}

/** Every label event on the ticket, all pages up to MAX_EVENT_PAGES. */
async function allLabelEvents(base, token, overall, first) {
  const events = asArray(first.body, 'the label events');
  const plan = labelEventPages(first.headers.get('x-total-pages'), events.length);
  const page = (n) => getJson(`${base}/resource_label_events?per_page=${PER_PAGE}&page=${n}`,
    token, overall, `label events page ${n}`);
  if (plan.tooMany) throw new ReadyError('too-many', `too many label events (${plan.tooMany} pages)`);
  if (plan.pages) {
    for (const r of await Promise.all(plan.pages.map(page))) events.push(...asArray(r.body, 'the label events'));
    return events;
  }
  for (let n = 2; n <= MAX_EVENT_PAGES; n += 1) {
    const more = asArray((await page(n)).body, 'the label events');
    events.push(...more);
    if (more.length < PER_PAGE) return events;
  }
  throw new ReadyError('too-many', `too many label events (more than ${MAX_EVENT_PAGES} pages)`);
}

/** Everything the check needs from the environment and config/project.json, or the first thing missing. */
function settings() {
  const env = process.env;
  const iid = Number(env.ONESHOT_TICKET);
  const missing = (what) => ({ problem: `${what} is missing`, iid: Number.isInteger(iid) && iid > 0 ? iid : 0 });
  if (!Number.isInteger(iid) || iid <= 0) return missing('the ticket number (ONESHOT_TICKET)');
  if (!env.ONESHOT_AUTOMATION_TOKEN) return missing('the GitLab token (ONESHOT_AUTOMATION_TOKEN)');
  if (!env.ONESHOT_AUTOMATION_API) return missing('the GitLab API URL (ONESHOT_AUTOMATION_API)');
  if (!env.ONESHOT_AUTOMATION_PROJECT) return missing('the GitLab project (ONESHOT_AUTOMATION_PROJECT)');
  const cfg = C.loadConfig('project.json');
  const auto = cfg && cfg.automation;
  const labels = auto && auto.labels;
  if (!labels || !labels.trigger || !labels.deployed) return missing('config/project.json automation.labels');
  const loop = cfg.labels && cfg.labels.entry;
  if (!loop) return missing('config/project.json labels.entry');
  if (!auto.releaseBranchPattern) return missing('config/project.json automation.releaseBranchPattern');
  const protectedBranches = cfg.branches && Array.isArray(cfg.branches.protected) ? cfg.branches.protected : null;
  if (!protectedBranches) return missing('config/project.json branches.protected');
  let releaseBranch;
  try {
    // The config holds a flagless regex source; the flag lives here, so an
    // `adhoc-…` branch is a release branch too.
    releaseBranch = new RegExp(auto.releaseBranchPattern, 'i');
  } catch {
    return missing('a valid config/project.json automation.releaseBranchPattern');
  }
  return {
    iid,
    token: env.ONESHOT_AUTOMATION_TOKEN,
    base: `${env.ONESHOT_AUTOMATION_API.replace(/\/+$/, '')}/projects/` +
      `${encodeURIComponent(env.ONESHOT_AUTOMATION_PROJECT)}/issues/${iid}`,
    labels: { trigger: labels.trigger, deployed: labels.deployed, loop },
    protectedBranches,
    releaseBranch,
  };
}

async function check() {
  const s = settings();
  if (s.problem) return unknownReadiness(s.iid, s.problem, 'config');
  const overall = AbortSignal.timeout(DEADLINE_MS);
  try {
    const [issue, firstEvents, mrs] = await Promise.all([
      getJson(s.base, s.token, overall, 'the ticket'),
      getJson(`${s.base}/resource_label_events?per_page=${PER_PAGE}&page=1`, s.token, overall, 'the label events'),
      getJson(`${s.base}/related_merge_requests?per_page=${PER_PAGE}`, s.token, overall, 'the linked merge requests'),
    ]);
    if (!issue.body || typeof issue.body !== 'object' || issue.body.iid !== s.iid) {
      throw new ReadyError('other', 'GitLab sent the ticket in an unexpected shape');
    }
    const events = await allLabelEvents(s.base, s.token, overall, firstEvents);
    return decideReadiness({
      issue: issue.body,
      events,
      mrs: asArray(mrs.body, 'the linked merge requests'),
      labels: s.labels,
      protectedBranches: s.protectedBranches,
      releaseBranch: s.releaseBranch,
    });
  } catch (err) {
    if (err instanceof ReadyError) return unknownReadiness(s.iid, err.message, err.kind);
    throw err;
  }
}

function finish(out) {
  // Pipes are asynchronous on macOS: exit only once the verdict is written, or
  // a long one could be cut off and read as non-JSON.
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

async function main() {
  if (C.phase() !== PHASE) C.allow();   // defence in depth: hooks.ts registers this for PHASE only
  C.readInput();                        // the payload is not needed, only drained
  let r;
  try {
    r = await check();
  } catch (err) {
    // A bug in this file must block too: say so, and leave the stack in
    // hook-errors.log rather than on the ticket.
    C.logFailure('automation-ready', err);
    r = unknownReadiness(Number(process.env.ONESHOT_TICKET) || 0,
      `the readiness check failed (${(err && err.message) || err})`, 'other');
  }
  C.event('automation_ready', {
    verdict: r.verdict,
    codes: r.reasons.map((x) => x.code),
    fingerprint: r.fingerprint,
    errorKind: r.errorKind,
  });
  finish(renderOutput(r));
}

module.exports = {
  decideReadiness, isPromotionBranch, fingerprint, renderOutput, labelEventPages, classifyHttp,
  PHASE, DEADLINE_MS,
};

if (require.main === module) {
  main().catch((err) => {
    // Last resort: even a failure while answering must answer with a block.
    C.logFailure('automation-ready main', err);
    finish({ decision: 'block', reason: 'Cannot check readiness: the readiness hook failed while answering.' });
  });
}
