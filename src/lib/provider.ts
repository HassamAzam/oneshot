/**
 * Which model provider a session talks to, and what that puts in its environment.
 *
 * Oneshot was built on a Claude subscription, and `config.ts` guards that by
 * deleting every metered-billing variable from the session environment. A
 * desk that wants another provider — DeepSeek, BytePlus ModelArk, any endpoint
 * that speaks the Anthropic Messages API — needs exactly those variables set,
 * on purpose, to deliberate values. This module is the one place that decides
 * them, from two lines of .env:
 *
 *   ONESHOT_LLM_PROVIDER=deepseek      a preset in config/providers.json
 *   ONESHOT_LLM_API_KEY=...            that provider's key
 *
 * The Claude Code runtime the Agent SDK spawns routes by ANTHROPIC_BASE_URL and
 * authenticates with ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer`) or
 * ANTHROPIC_API_KEY (sent as `x-api-key`), and resolves the `opus` / `sonnet` /
 * `haiku` aliases — which the bundled subagents and its own background calls use —
 * through ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL. A provider is therefore a
 * base URL, an auth style, and a tier-to-model map; everything else is the same
 * harness.
 *
 * Pure: takes the preset table and an environment, returns a verdict. Nothing
 * here reads a file or the process, so the resolution is testable and
 * `config.ts` stays the only reader of config/providers.json.
 */
import { readEnv } from './repourl.cjs';

export type Tier = 'heavy' | 'standard' | 'light';
export const TIERS: readonly Tier[] = ['heavy', 'standard', 'light'];

export type Billing = 'subscription' | 'metered';
export type AuthStyle = 'bearer' | 'x-api-key';

/** One entry of config/providers.json. Every field is optional; .env fills the rest. */
export interface ProviderPreset {
  label?: string;
  billing?: Billing;
  baseUrl?: string;
  auth?: AuthStyle;
  tiers?: Partial<Record<Tier, string>>;
  /** Extra variables the runtime needs for this endpoint, set verbatim in every session. */
  env?: Record<string, string>;
  /**
   * How long a phase may emit nothing before it is judged stalled, in minutes.
   *
   * The default is tuned for Claude Code, where the only legitimate silent
   * stretch is one tool call and the CLI caps a Bash call at ten minutes. A
   * reasoning model breaks that assumption: it can think for a long time
   * without the runtime emitting a frame, and a provider that queues can be
   * silent before it has even started. Silence stops being evidence of a
   * wedged session, so the provider that changes the meaning carries the
   * number.
   */
  idleMin?: number;
  /** Shown by doctor and the boot banner: what to know before trusting this preset. */
  notes?: string[];
}

export interface ProvidersTable {
  default?: string;
  providers: Record<string, ProviderPreset>;
}

export interface ResolvedProvider {
  name: string;
  label: string;
  billing: Billing;
  /** null for the subscription provider: the runtime goes to its own default endpoint. */
  baseUrl: string | null;
  authVar: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  /** Whether a key was found. The value itself is never reported. */
  hasKey: boolean;
  /** null means config/models.json decides, as it always has. */
  tiers: Record<Tier, string> | null;
  /** What reaches every session on top of the scrubbed base environment. */
  sessionEnv: Record<string, string>;
  /** Minutes of silence before a phase is judged stalled; null leaves the default alone. */
  idleMin: number | null;
  /** A session started with these would fail or bill somewhere unintended. Refuses boot. */
  problems: string[];
  /** Worth knowing; nothing to fix. */
  notes: string[];
}

export const PROVIDER_VAR = 'ONESHOT_LLM_PROVIDER';
export const API_KEY_VAR = 'ONESHOT_LLM_API_KEY';
export const BASE_URL_VAR = 'ONESHOT_LLM_BASE_URL';
export const AUTH_VAR = 'ONESHOT_LLM_AUTH';
export const SUBSCRIPTION_PROVIDER = 'claude';

export function tierVar(tier: Tier): string { return `ONESHOT_LLM_MODEL_${tier.toUpperCase()}`; }

/**
 * The variable that pins ONE phase to ONE model, overriding its tier.
 *
 * For the case where a phase needs a capability its tier's model lacks rather
 * than more or less of the same thing. The measured example: `design` renders
 * mockups and is then told to read its own screenshots critically, which needs
 * vision — and a provider can serve a stronger model that cannot see. Moving
 * the whole tier would change six other phases to fix one.
 *
 * Desk-local on purpose. `config/models.json`'s `overrides` is the fleet-wide
 * lever and maps a phase to a TIER, so using it here would also re-tier the
 * phase for every desk on every other provider. This pins a model id, for this
 * desk, and leaves both alone.
 */
export function phaseModelVar(phase: string): string {
  return `ONESHOT_LLM_MODEL_${phase.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * The model pinned for `phase`, or ''.
 *
 * A phase whose name would spell a TIER variable is refused rather than allowed
 * to read it: `ONESHOT_LLM_MODEL_HEAVY` means "the heavy tier", and a phase
 * named `heavy` silently answering to it would make one line mean two things.
 * No phase is named that today; this is here so adding one cannot introduce it
 * quietly.
 */
export function phaseModel(phase: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = phaseModelVar(phase);
  if (TIERS.some((t) => tierVar(t) === name)) return '';
  return readEnv(env, name, '');
}

const AUTH_HEADER_VAR: Record<AuthStyle, ResolvedProvider['authVar']> = {
  bearer: 'ANTHROPIC_AUTH_TOKEN',
  'x-api-key': 'ANTHROPIC_API_KEY',
};

function readTiers(preset: ProviderPreset, env: NodeJS.ProcessEnv): { tiers: Record<Tier, string>; missing: Tier[] } {
  const tiers = {} as Record<Tier, string>;
  const missing: Tier[] = [];
  for (const tier of TIERS) {
    const value = readEnv(env, tierVar(tier), preset.tiers?.[tier] ?? '');
    if (value) tiers[tier] = value;
    else missing.push(tier);
  }
  return { tiers, missing };
}

/**
 * The variables a metered provider puts in a session, in the order a reader
 * would want to check them: where, with what, then which model each alias means.
 *
 * ANTHROPIC_SMALL_FAST_MODEL and CLAUDE_CODE_SUBAGENT_MODEL are set alongside the
 * ANTHROPIC_DEFAULT_* trio because the bundled runtime (Claude Code 2.0.x) still
 * reads both for background and subagent calls; left unset, those calls would
 * ask the provider for a `claude-haiku-*` it has never heard of.
 */
function meteredSessionEnv(p: {
  baseUrl: string; authVar: ResolvedProvider['authVar']; apiKey: string; tiers: Record<Tier, string>; extra: Record<string, string>;
}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    [p.authVar]: p.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.tiers.heavy,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.tiers.standard,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.tiers.light,
    ANTHROPIC_SMALL_FAST_MODEL: p.tiers.light,
    CLAUDE_CODE_SUBAGENT_MODEL: p.tiers.standard,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...p.extra,
  };
}

/**
 * Resolve the active provider from the preset table and an environment.
 *
 * Never throws: a misconfiguration is a `problems` entry, so boot and doctor can
 * print every one of them at once instead of the first.
 */
export function resolveProvider(table: ProvidersTable, env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const problems: string[] = [];
  const notes: string[] = [];
  const name = readEnv(env, PROVIDER_VAR, table.default ?? SUBSCRIPTION_PROVIDER).trim().toLowerCase();
  const preset = table.providers[name];
  const known = Object.keys(table.providers).join(', ');
  if (!preset) {
    problems.push(`${PROVIDER_VAR}=${name} is not a provider in config/providers.json (${known})`);
  }

  const billing: Billing = preset?.billing ?? (name === SUBSCRIPTION_PROVIDER ? 'subscription' : 'metered');
  const label = preset?.label ?? name;
  const apiKey = readEnv(env, API_KEY_VAR, '');
  const hasKey = apiKey !== '';
  if (preset?.notes) notes.push(...preset.notes);

  if (billing === 'subscription') {
    if (hasKey) notes.push(`${API_KEY_VAR} is set but ${PROVIDER_VAR} is ${name}: the key is ignored and never reaches a session`);
    return {
      name, label, billing, baseUrl: null, authVar: 'ANTHROPIC_AUTH_TOKEN', hasKey,
      tiers: null, sessionEnv: {}, idleMin: null, problems, notes,
    };
  }

  const authStyle = readEnv(env, AUTH_VAR, preset?.auth ?? 'bearer').toLowerCase();
  if (authStyle !== 'bearer' && authStyle !== 'x-api-key') {
    problems.push(`${AUTH_VAR}=${authStyle} must be bearer or x-api-key`);
  }
  const authVar = AUTH_HEADER_VAR[(authStyle as AuthStyle) in AUTH_HEADER_VAR ? (authStyle as AuthStyle) : 'bearer'];

  const baseUrl = readEnv(env, BASE_URL_VAR, preset?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    problems.push(`${BASE_URL_VAR} is unset and the ${name} preset names no endpoint`);
  } else {
    try {
      const host = new URL(baseUrl).hostname;
      if (host === 'api.anthropic.com') {
        notes.push(`${BASE_URL_VAR} points at api.anthropic.com: this is Anthropic's metered API, billed to the key, not the subscription`);
      }
    } catch {
      problems.push(`${BASE_URL_VAR} is not a URL: ${baseUrl}`);
    }
  }

  if (!hasKey) problems.push(`${API_KEY_VAR} is unset; the ${name} provider cannot authenticate without it`);

  const { tiers, missing } = readTiers(preset ?? {}, env);
  for (const tier of missing) {
    problems.push(`${tierVar(tier)} is unset and the ${name} preset names no ${tier} model`);
  }

  const sessionEnv = problems.length === 0
    ? meteredSessionEnv({ baseUrl, authVar, apiKey, tiers, extra: preset?.env ?? {} })
    : {};

  const idleMin = typeof preset?.idleMin === 'number' && preset.idleMin > 0 ? preset.idleMin : null;

  return {
    name, label, billing, baseUrl: baseUrl || null, authVar, hasKey,
    tiers: missing.length === 0 ? tiers : null, sessionEnv, idleMin, problems, notes,
  };
}

/** One line for the boot banner and doctor: never the key, never a full URL with a secret in it. */
export function describeProvider(p: ResolvedProvider): string {
  if (p.billing === 'subscription') return `${p.name} (subscription) — models from config/models.json`;
  let host = p.baseUrl ?? '?';
  try { host = new URL(p.baseUrl ?? '').host; } catch { /* reported as a problem elsewhere */ }
  const tiers = p.tiers
    ? TIERS.map((t) => `${t}=${p.tiers![t]}`).join(' ')
    : 'tiers incomplete';
  return `${p.name} (metered) via ${host}, ${p.authVar}: ${tiers}`;
}
