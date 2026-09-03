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

/** A milestone reply in the ticket's thread. Milestones only — the card is the status. */
export async function thread(ts: string | null, text: string): Promise<void> {
  if (!slackEnabled()) { log.info(`[slack] ${text.slice(0, 160)}`); return; }
  await call('chat.postMessage', {
    channel: channel(),
    thread_ts: ts ?? undefined,
    text,
    unfurl_links: false,
  });
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
