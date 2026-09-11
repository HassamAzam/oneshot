/**
 * The single Slack voice.
 *
 * v1 ran seven persona apps because seven independent loops each needed to
 * speak. Oneshot has one orchestrator, so one app, one token, one channel.
 *
 * The root message per ticket is a status card EDITED IN PLACE as phases
 * complete; thread replies are milestones only. Without the edit-in-place, a
 * 90-minute implement phase produces either silence or spam.
 *
 * Every function no-ops without a token or channel, so the conductor runs
 * exactly the same with Slack unconfigured — status just stays on the console.
 */
import { envOr, projectConfig, slackConfig } from './config.js';
import { log } from './log.js';

const API = 'https://slack.com/api';

/**
 * Every call here sits AWAITED on the critical path of a run — the card is
 * updated at every phase boundary — so an unresponsive slack.com would stall
 * the pipeline on a channel nobody is reading. Status reporting must never be
 * able to cost more than the work it reports on.
 */
const CALL_TIMEOUT_MS = 15_000;

/** Warn once per outage, not once per phase boundary. */
let unreachable = false;

function token(): string { return envOr('SLACK_BOT_TOKEN'); }
function channel(): string { return slackConfig().channel; }
export function slackEnabled(): boolean { return Boolean(token() && channel()); }

async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    // Form-encoded, not JSON: confirmed live that conversations.replies (and
    // likely conversations.history) reject an application/json body outright
    // with invalid_arguments / "missing required field" for fields that ARE
    // present — Slack's read-oriented Web API methods parse form bodies only.
    // chat.postMessage/chat.update accept form encoding too (none of this
    // file's calls pass a nested object needing JSON-stringified block/
    // attachment fields), so one encoding covers every method here.
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      form.set(k, String(v));
    }
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: form,
      signal: ctl.signal,
    });
    const json = (await res.json()) as Record<string, unknown>;
    unreachable = false;
    if (!json.ok) {
      // Report the error CODE only. Slack echoes request fields on some errors,
      // and this line goes to a log file.
      log.warn(`slack ${method} failed`, { error: json.error });
    }
    return json;
  } catch (err) {
    // Degrade to exactly the no-token shape: callers already handle a Slack
    // that is not configured, so a Slack that is not answering is the same
    // situation and the run carries on with the console as its only channel.
    if (!unreachable) {
      unreachable = true;
      log.warn('slack is unreachable — status stays on this console', {
        error: (err as Error).message,
      });
    }
    return { ok: false, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export interface PhaseLine {
  phase: string;
  state: 'done' | 'running' | 'pending' | 'failed' | 'skipped';
  detail?: string;
}

const ICON: Record<PhaseLine['state'], string> = {
  done: ':white_check_mark:',
  running: ':hourglass_flowing_sand:',
  pending: ':white_circle:',
  failed: ':x:',
  skipped: ':heavy_minus_sign:',
};

export interface CardState {
  iid: number;
  title: string;
  url: string;
  lines: PhaseLine[];
  elapsedMs: number;
  weighted: number;
  status: 'running' | 'blocked' | 'done' | 'aborted' | 'parked';
  blockedWhy?: string;
  /** Whose desk is driving this run — see `operatorName()` in lib/config.ts. */
  owner?: string;
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderCard(s: CardState): string {
  const cfg = slackConfig();
  // The owner rides on the head line: when several desks post into one
  // channel, whose ticket a card is has to be readable at a glance.
  const head = `*<${s.url}|#${s.iid}> ${s.title}*${s.owner ? ` · _${s.owner}_` : ''}`;
  const body = s.lines
    .map((l) => `${ICON[l.state]} ${l.phase}${l.detail ? ` — ${l.detail}` : ''}`)
    .join('\n');

  const meta: string[] = [];
  if (cfg.card.showElapsed) meta.push(fmtElapsed(s.elapsedMs));
  if (cfg.card.showTokens && s.weighted) meta.push(`${(s.weighted / 1e6).toFixed(2)}M weighted`);

  let footer = meta.length ? `\n_${meta.join(' · ')}_` : '';
  if (s.status === 'blocked') {
    const owner = envOr('ONESHOT_OWNER_SLACK_ID');
    footer += `\n:rotating_light: *BLOCKED* — ${s.blockedWhy ?? 'unknown'}${owner ? ` <@${owner}>` : ''}`;
  }
  if (s.status === 'parked') {
    footer += `\n:pause_button: *awaiting review* — ${s.blockedWhy ?? 'Review label pause'}`;
  }
  // `merge` is the last phase, so a done run that reached it is the whole
  // success condition — and the label the ticket carries is the one named here.
  const merged = s.lines.some((l) => l.phase === 'merge' && l.state === 'done');
  if (s.status === 'done' && merged) footer += `\n:tada: *${projectConfig().labels.exit}*`;

  return `${head}\n${body}${footer}`;
}

/** Post the card for the first time. Returns the ts used to edit it later. */
export async function postCard(s: CardState): Promise<string | null> {
  if (!slackEnabled()) return null;
  const res = await call('chat.postMessage', {
    channel: channel(), text: renderCard(s), unfurl_links: false,
  });
  return typeof res.ts === 'string' ? res.ts : null;
}

export async function updateCard(ts: string, s: CardState): Promise<void> {
  if (!slackEnabled() || !ts) return;
  await call('chat.update', { channel: channel(), ts, text: renderCard(s) });
}

export interface ThreadOpts {
  /**
   * Also surface this reply in the CHANNEL, not only inside the thread.
   *
   * Slack's own `reply_broadcast` rather than a second `chat.postMessage`:
   * one post, so the thread stays the single record of the run and the
   * channel copy Slack renders points back at it. Posting twice would put
   * the same text in two places that then have to be kept in step, and would
   * double the notification for anyone already following the thread.
   *
   * Reserved for messages that need somebody who is NOT watching this run to
   * act — today that is the review gates' approval requests and nothing else.
   * A milestone belongs in the thread, which is why this defaults off.
   */
  broadcast?: boolean;
}

/**
 * A reply in the ticket's thread. Milestones only, ordinarily — the card is
 * the status — but the review gates (src/conductor/reviewgate.ts) also post
 * their approval requests through here, with `broadcast` set so the ask also
 * lands in the channel where the reviewers who are not following this run
 * will see it. The gates read their verdict off the GitLab ticket, never out
 * of Slack, so a request posted here is a notification and not an inbox.
 *
 * Returns the posted message's own `ts`, so a caller that needs a "since"
 * marker for polling replies (`threadReplies` below) does not have to make a
 * second call just to learn what it already has the answer to. Null when
 * Slack is unconfigured, unreachable, or the post itself failed — a caller
 * that cares (the review gate) treats null as "try again next tick", exactly
 * like every other Slack failure in this file degrades to the console.
 */
export async function thread(
  ts: string | null, text: string, opts: ThreadOpts = {},
): Promise<string | null> {
  if (!slackEnabled()) { log.info(`[slack] ${text.slice(0, 160)}`); return null; }
  const res = await call('chat.postMessage', {
    channel: channel(),
    thread_ts: ts ?? undefined,
    text,
    // Slack ignores this without a thread_ts, but sending it anyway on a
    // root post is a request that means nothing; keep it to the case it
    // describes.
    reply_broadcast: ts && opts.broadcast ? 'true' : undefined,
    unfurl_links: false,
  });
  return typeof res.ts === 'string' ? res.ts : null;
}

/**
 * A Slack member id for a work email, or null.
 *
 * Slack renders an @mention from a member id (`<@U01ABC>`) and from nothing
 * else — a username, a display name or an email in the message text is just
 * text, and silently so. The review gates hold GitLab usernames, so something
 * has to bridge the two; this is that bridge, via `users.lookupByEmail` on
 * the address derived from the username (see `mentionsFor` in
 * src/conductor/reviewgate.ts).
 *
 * NEW SCOPE, AND A MANUAL ONE. `chat:write` covers every other call in this
 * file. Looking a user up by email needs `users:read.email` (which implies
 * `users:read`) granted to the bot token in the Slack API console, followed
 * by a reinstall to the workspace — a token cannot grant itself a scope. Skip
 * it and Slack answers `missing_scope`: `call()` logs the code, this returns
 * null, and the gate's request still posts, just without naming anyone. That
 * is the deliberate failure shape — an approval request that reaches the
 * channel unaddressed is recoverable by a human reading it, whereas one that
 * is not posted at all is not.
 *
 * Cached per process, INCLUDING the misses. A miss is either a scope that has
 * not been granted or an address that does not exist in the workspace, and
 * neither changes while the conductor is up; re-asking on every gate round
 * would spend a network round trip per reviewer per round to be told the same
 * thing. A restart re-reads both, which is also how a newly granted scope
 * takes effect.
 */
const emailIds = new Map<string, string | null>();

export async function userIdForEmail(email: string): Promise<string | null> {
  if (!slackEnabled() || !email) return null;
  const key = email.toLowerCase();
  const cached = emailIds.get(key);
  if (cached !== undefined) return cached;
  const res = await call('users.lookupByEmail', { email: key });
  const user = res.user as Record<string, unknown> | undefined;
  const id = res.ok === true && user && typeof user.id === 'string' ? user.id : null;
  // Do not cache a miss caused by the network being down — that one DOES
  // change, and caching it would keep a run unaddressed for the rest of the
  // process's life over a blip that lasted a second.
  if (id !== null || res.error !== 'unreachable') emailIds.set(key, id);
  return id;
}

/**
 * Slack handle (`@name`) → member id, for the whole workspace, built once.
 *
 * The PRIMARY way a reviewer gets mentioned, because at Arbisoft a person's
 * Slack handle is character-identical to their GitLab username — `arsal.tariq`
 * is `@arsal.tariq` in both systems — which makes it an exact key needing no
 * scope beyond `users:read`, and no second list for anyone to maintain.
 *
 * Handles ONLY. Display and real names are deliberately never matched: this
 * workspace has 790 people, 22 of whom answer to some form of "usman", and
 * `haider.usman`'s display name is the bare word "Haider". A fuzzy match
 * across those does not fail loudly, it mentions the wrong person — which is
 * worse than mentioning nobody, since the run still waits and now someone
 * else has been asked to approve work that is not theirs.
 *
 * One `users.list` walk per process (a few hundred per page), cached whole
 * rather than per lookup: a gate mentions two to four people at once, so
 * paying for the roster once beats a call each. Not cached on failure, so a
 * blip does not poison the rest of the run.
 */
/**
 * The in-flight walk, not just its result — every caller of `userIdForHandle`
 * shares ONE `users.list` pass.
 *
 * Caching only the finished map is not enough here, and the difference is not
 * theoretical: a gate resolves its whole reviewer group through
 * `Promise.all`, so four lookups start in the same tick, all miss an
 * unpopulated cache, and all four begin their own multi-page walk. Against a
 * 790-person workspace that is ~16 requests where 4 would do, on a method
 * Slack rate-limits at tier 2 — the later pages then come back 429, each
 * walker keeps whatever partial roster it had, and reviewers go unmentioned
 * essentially at random. Observed exactly that way: `hira.ijaz` and
 * `anosha.saeed` silently dropped out of an otherwise correct list.
 *
 * Cleared on failure so a later gate retries rather than inheriting a partial
 * answer for the life of the process.
 *
 * A 429 is NOT retried inline, deliberately. Slack's tier-2 window is a
 * minute, so honouring a Retry-After here would park a phase mid-check for
 * that long to add decoration to a message that is about to post anyway. The
 * ask goes out unaddressed instead and the next tick — a gate re-checks on
 * every scan while parked — rebuilds the roster and mentions properly from
 * then on. One walk per process makes hitting the limit unlikely in the
 * first place; it is reachable mainly by restarting the conductor repeatedly.
 */
let rosterWalk: Promise<Map<string, string>> | null = null;

async function walkRoster(): Promise<Map<string, string>> {
  const built = new Map<string, string>();
  let cursor = '';
  do {
    const res = await call('users.list', { limit: 200, cursor: cursor || undefined });
    if (res.ok !== true) throw new Error(`users.list: ${String(res.error)}`);
    for (const m of (res.members as Array<Record<string, unknown>>) ?? []) {
      if (m.deleted === true || m.is_bot === true) continue;
      if (typeof m.name === 'string' && typeof m.id === 'string') built.set(m.name.toLowerCase(), m.id);
    }
    const meta = res.response_metadata as Record<string, unknown> | undefined;
    cursor = typeof meta?.next_cursor === 'string' ? meta.next_cursor : '';
  } while (cursor);
  return built;
}

function handleRoster(): Promise<Map<string, string>> {
  if (!rosterWalk) {
    rosterWalk = walkRoster().catch((err) => {
      rosterWalk = null; // a partial or failed walk must not become the answer
      log.warn('could not read the Slack member list — reviewers will not be @mentioned', {
        error: (err as Error).message,
      });
      return new Map<string, string>();
    });
  }
  return rosterWalk;
}

export async function userIdForHandle(handle: string): Promise<string | null> {
  if (!slackEnabled() || !handle) return null;
  return (await handleRoster()).get(handle.toLowerCase()) ?? null;
}

let cachedBotUserId: string | null = null;

/**
 * This app's own Slack user id, resolved once via `auth.test` and cached.
 *
 * Needed to tell a human's reply apart from the bot's own messages when
 * polling a thread (`threadReplies`): a message posted with this bot's token
 * carries a `bot_id`, but so would a message from any OTHER bot in the same
 * workspace, so `bot_id` alone is not a safe "that was me" test. The user id
 * `auth.test` reports for THIS token is.
 */
async function botUserId(): Promise<string | null> {
  if (cachedBotUserId) return cachedBotUserId;
  if (!slackEnabled()) return null;
  const res = await call('auth.test', {});
  if (res.ok === true && typeof res.user_id === 'string' && res.user_id) {
    cachedBotUserId = res.user_id;
    return cachedBotUserId;
  }
  return null;
}

export interface ThreadReply {
  ts: string;
  text: string;
  /**
   * The Slack user id that posted the reply, or null when Slack did not name
   * one. Carried so a caller deciding whether a reply is AUTHORISED — the
   * review gate's approval check against `slackConfig().allowlist` — has the
   * one field that decision needs, rather than trusting whoever typed first.
   */
  user: string | null;
}

/**
 * Human replies posted in a thread strictly after `sinceTs`, oldest first —
 * the read half of the review gate's Slack polling (src/conductor/
 * reviewgate.ts), which is otherwise post-only like the rest of this file.
 *
 * Backed by Slack's `conversations.replies` Web API method. This is a NEW
 * scope requirement: every other call in this file only ever posts or edits
 * a message, which `chat:write` alone covers, but reading a channel's history
 * back — thread replies included — needs `channels:history` (a public
 * channel) or `groups:history` (a private one) granted to the bot token on
 * top of that. A token cannot grant itself a new scope, so this is a Slack
 * app configuration change a human has to make manually in the Slack API
 * console before the Review label's gates can see a reply at all — see
 * README's "Optional human review gates". Absent the scope, Slack answers
 * `missing_scope`, `call()` logs it and returns no `messages`, and this
 * function degrades to an empty list rather than throwing — the gate then
 * just stays 'pending' forever, which is a visible, diagnosable stall rather
 * than a crash.
 *
 * Only the first page is read (Slack's default page, on the order of a
 * hundred messages) — the same bet `issueNotes()` makes for GitLab comments:
 * a thread this deep into unread replies before the first `approved` is not
 * the case this gate exists to serve.
 */
export async function threadReplies(threadTs: string, sinceTs: string | null): Promise<ThreadReply[]> {
  if (!slackEnabled() || !threadTs) return [];
  const me = await botUserId();
  const res = await call('conversations.replies', { channel: channel(), ts: threadTs });
  const messages = Array.isArray(res.messages) ? (res.messages as Array<Record<string, unknown>>) : [];
  const since = sinceTs ? Number(sinceTs) : 0;
  return messages
    .filter((m) => typeof m.ts === 'string' && Number(m.ts) > since)
    .filter((m) => !m.bot_id && m.user !== me)
    .filter((m): m is Record<string, unknown> & { ts: string; text: string } => (
      typeof m.text === 'string' && m.text.trim() !== ''
    ))
    .map((m) => ({ ts: m.ts, text: m.text, user: typeof m.user === 'string' ? m.user : null }))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * The @mention for something that has gone WRONG. Full auto means nothing
 * else should need attention — the review gates also mention people
 * (`mentionsFor` in src/conductor/reviewgate.ts), but that is an ask that was
 * asked for, addressed to the group that opted into answering it. This one
 * goes to the operator, unbidden, because a run stopped.
 */
export async function alert(text: string): Promise<void> {
  if (!slackEnabled()) { log.error(`[slack-alert] ${text}`); return; }
  const owner = envOr('ONESHOT_OWNER_SLACK_ID');
  const res = await call('chat.postMessage', {
    channel: channel(),
    text: `${owner ? `<@${owner}> ` : ''}${text}`,
  });
  // The one message that must not be lost to a network blip. If it did not
  // land, put it where the operator will at least find it afterwards.
  if (res.ok !== true) log.error(`[slack-alert] ${text}`);
}

export async function verifyAuth(): Promise<{ ok: boolean; team?: string; user?: string }> {
  if (!token()) return { ok: false };
  const res = await call('auth.test', {});
  return {
    ok: res.ok === true,
    team: typeof res.team === 'string' ? res.team : undefined,
    user: typeof res.user === 'string' ? res.user : undefined,
  };
}
