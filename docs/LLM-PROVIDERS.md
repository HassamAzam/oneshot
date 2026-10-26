# Running Oneshot on a model other than Claude

Oneshot drives tickets through fresh Claude Code sessions, and Claude Code talks to one
endpoint that speaks the Anthropic Messages API. That is the whole seam. Any provider which
serves that API can serve this pipeline, and the switch is two lines of `.env`:

```bash
ONESHOT_LLM_PROVIDER=deepseek
ONESHOT_LLM_API_KEY=sk-…
```

`claude` remains the default and needs no line at all. Nothing about a subscription desk
changes: no base URL, no key, the same `claude login` credential, the same models from
`config/models.json`.

## What a provider is

Three facts, held in `config/providers.json`:

| Field | Meaning |
|---|---|
| `baseUrl` | an endpoint that speaks the Anthropic Messages API |
| `auth` | `bearer` sends the key as `Authorization: Bearer`, `x-api-key` sends it as `x-api-key` |
| `tiers` | `heavy` / `standard` / `light` → that provider's model names |

The tiers are the part people underestimate. Phases ask for a tier, never a model id, so the
map is all it takes to re-point the pipeline. But the Claude Code runtime also resolves the
`opus`, `sonnet` and `haiku` **aliases** on its own — the bundled subagents in
`context/agents/*.md` ask for them by name, and the runtime makes its own background calls on
the haiku one. So `src/lib/provider.ts` sets `ANTHROPIC_DEFAULT_OPUS_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`
and `CLAUDE_CODE_SUBAGENT_MODEL` from the same three tiers. Left unset, every one of those
calls would ask your provider for a `claude-*` model it has never heard of.

## The one safety rule this had to not break

`src/lib/config.ts` builds the session environment from scratch — the SDK's `env` option
*replaces* the subprocess environment rather than merging, which is what makes it a control —
and **deletes** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`. That is what stops a key in somebody's shell
turning a subscription fleet into a metered bill with no signal.

A provider puts those names back, and the **order** is the control: the strip runs first,
then `provider.sessionEnv` is assigned over the result. So a session can only ever carry
values this desk chose in `.env`, never values it inherited. Three consequences, each covered
by a test in `src/lib/provider-env.test.ts`:

- A shell carrying `ANTHROPIC_API_KEY` still cannot reach a session, on either provider — and
  it is still a `doctor` failure, because it still bills the operator's own interactive
  sessions.
- `CLAUDE_CODE_OAUTH_TOKEN` travels only on a subscription desk. Beside a provider key it
  would be a second model credential with nothing to do.
- A half-configured provider (a key with no endpoint, a missing tier) wires **nothing** and
  refuses boot, rather than starting sessions that would fail one at a time.

Because a metered session does carry a credential in its environment, `hooks/secret-guard.cjs`
grew a rule to match: while one is present, naming it (`echo $ANTHROPIC_AUTH_TOKEN`) or
dumping the environment (`env`, `printenv`, `set`) is denied. On a keychain desk the same
command is allowed, because there is nothing there to reveal.

## Switching a desk

```bash
# 1. pick a provider and give it a key
ONESHOT_LLM_PROVIDER=deepseek
ONESHOT_LLM_API_KEY=sk-…

# 2. prove the wiring before a ticket does
npm run doctor        # shows the endpoint, the header and the three models
npm run llm:probe     # sends ONE turn through the real session environment
```

`npm run llm:probe` is the check no static inspection can do. It spawns the bundled runtime
with exactly the environment a phase gets and asks two questions per tier, because a phase
needs two things and they fail separately:

- **reply** — a one-word answer. Proves the endpoint, the auth header and the model id. A
  wrong key shows up as a 401 in the stderr it prints, a wrong model id as the provider's own
  error, an endpoint that is not Anthropic-compatible as a session with no frames at all.
- **schema** — a one-field JSON schema. Proves structured output, which **every** phase
  depends on (`src/conductor/schemas.ts`) and which a provider can decline while answering
  ordinary prompts perfectly. DeepSeek's endpoint documents `thinking`, `output_config.effort`
  and tool calls, but says nothing about `output_config.format`. A provider that fails this
  line cannot run this pipeline, however healthy the first one looks.

It probes the `standard` tier by default; `npm run llm:probe -- --tier all` runs both checks
against all three.

Per-desk overrides, all optional and all required for the `custom` preset:

```bash
ONESHOT_LLM_BASE_URL=https://…
ONESHOT_LLM_AUTH=bearer           # or x-api-key
ONESHOT_LLM_MODEL_HEAVY=…
ONESHOT_LLM_MODEL_STANDARD=…
ONESHOT_LLM_MODEL_LIGHT=…
```

### Pinning one phase to one model

A tier says how much model a phase needs. Sometimes a phase needs a *capability* the tier's
model lacks, and then re-tiering it would drag its tier-mates along. Pin it instead:

```bash
ONESHOT_LLM_MODEL_DESIGN=deepseek-flash[1m]
```

The variable is `ONESHOT_LLM_MODEL_<PHASE>` with hyphens as underscores, it beats every tier,
and it is desk-local. `config/models.json`'s `overrides` is the fleet-wide lever and maps a
phase to a *tier*, so it would change that phase for every desk on every provider.

The case this exists for is real and measured. `design` renders mockups at 1280×800 and is then
told to read its own screenshots critically, looking for misaligned edges, doubled borders and
contrast problems. That needs vision. On DeepSeek the heavy tier is `deepseek-v4-pro`, whose
published capability table says vision is not supported, while `deepseek-flash` supports it. So
the strongest model available is the one that cannot do this phase's last step. Of the seven
heavy phases — research, design, plan, testcases, review, remediate, mr-feedback — only `design`
reads an image back, so pinning that one is the whole fix. `verify`, `ui-evidence` and
`demo-recording` lean on screenshots too and are all `standard`, so they already have vision.

`npm run doctor` prints every pin, because a model chosen silently is how a phase ends up on one
that cannot do its job.

An OpenAI-shaped provider needs a translating proxy (LiteLLM, `claude-code-router`) in front
of it; point `ONESHOT_LLM_BASE_URL` at the proxy and use the `custom` preset.

## What does not come with you

Running off the subscription turns off things that were only ever true of it. None of these
stops a ticket; all of them change what a number means.

- **The reserve and the window ceilings.** `~/.claude/state/ratelimit.json` is a Claude
  subscription signal, so `accountWindowPct()` returns null and the account-wide reserve in
  `config/budgets.json` has nothing to read. The weighted-token ceilings still apply and still
  bound a run, but they are bounding a **bill** now, not somebody's 5-hour window.
- **Prompt caching.** The cache columns stay at zero on a provider that does not serve
  `cache_control`, so a weighted total on DeepSeek is not comparable with one on Claude — the
  cache-read weight of 0.1 was most of the discount.
- **Cost estimates.** `total_cost_usd` comes from a price table bundled in the runtime, keyed
  by model name. It means nothing for a model that table has never heard of. It already gated
  nothing.
- **Usage-limit parking.** `src/lib/quota.ts` recognises Claude's own limit wording. Another
  provider's 429 is not matched, so it fails the phase through its normal `onFail` policy
  instead of parking the desk.
- **Anthropic's support for any of this.** Anthropic documents gateway configuration but
  states it does not support routing Claude Code to non-Claude models. Tool-calling and
  structured output are tuned for Claude. Treat a new provider as unproven until you have
  watched a real ticket through it, and start with one that does not merge.

One trap worth naming: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is the usual advice when a
third-party endpoint rejects unknown request fields — and it removes `output_config.format`
along with them, which silently takes structured output away from every phase. If a provider
needs that flag to answer at all, it cannot run Oneshot; fix the provider, not the flag.

## The two providers shipped, and which to pick

**DeepSeek first-party** (`deepseek`) is the one to try first: pay-as-you-go, a documented
Anthropic endpoint, V4 on it, and no subscription terms to read. `deepseek-flash` is
V4.1-Flash and `deepseek-v4-pro` is V4-Pro; the older `deepseek-chat` and `deepseek-reasoner`
names are gone. Both are 1M context, which is why the preset's model names carry `[1m]`.

**BytePlus ModelArk** (`byteplus`) needs a warning read before it is used. Its
Anthropic-compatible endpoint exists only on the **Coding Plan** subscription, and that plan's
terms say it is not for API calls and that using its base URL outside an interactive AI coding
tool may be treated as abuse, up to account suspension. An unattended conductor spawning
hundreds of model calls per ticket is exactly that shape. Its quota is also counted in
**requests** over a 5-hour window rather than tokens, so nothing in `config/budgets.json`
bounds it. The preset is here because it works; whether your plan permits it is a question for
your plan, not for this repo. ModelArk's pay-as-you-go endpoint is OpenAI-shaped and billed
separately from the plan — for that, put LiteLLM in front and use `custom`.

## Adding a provider

Add an entry to `config/providers.json` and nothing else. `src/lib/provider.test.ts` walks
every preset in the shipped file and asserts each one resolves from its own fields plus a key,
has an `https` endpoint, names all three tiers, and carries a `notes` line saying what a
reader needs to know. A preset that cannot be configured from `.env` alone fails that test.
