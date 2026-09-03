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
import { envOr, slackConfig } from './config.js';
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
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
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
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderCard(s: CardState): string {
  const cfg = slackConfig();
  const head = `*<${s.url}|#${s.iid}> ${s.title}*`;
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
  const reachedClose = s.lines.some((l) => l.phase === 'close' && l.state === 'done');
  if (s.status === 'done' && reachedClose) footer += '\n:tada: *Ready For Deployment*';

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

/**
 * A reply in the ticket's thread. Milestones only, ordinarily — the card is
 * the status — but the opt-in Review label's gates (src/conductor/
 * reviewgate.ts) also use this to post their approval requests, since Slack
 * is their primary channel and a gate's request is just another threaded
 * reply that happens to want an answer.
 *
 * Returns the posted message's own `ts`, so a caller that needs a "since"
 * marker for polling replies (`threadReplies` below) does not have to make a
 * second call just to learn what it already has the answer to. Null when
 * Slack is unconfigured, unreachable, or the post itself failed — a caller
 * that cares (the review gate) treats null as "try again next tick", exactly
 * like every other Slack failure in this file degrades to the console.
 */
export async function thread(ts: string | null, text: string): Promise<string | null> {
  if (!slackEnabled()) { log.info(`[slack] ${text.slice(0, 160)}`); return null; }
  const res = await call('chat.postMessage', {
    channel: channel(),
    thread_ts: ts ?? undefined,
    text,
    unfurl_links: false,
  });
  return typeof res.ts === 'string' ? res.ts : null;
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
    .map((m) => ({ ts: m.ts, text: m.text }))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** The only unprompted @mention. Full auto means nothing else should need attention. */
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
