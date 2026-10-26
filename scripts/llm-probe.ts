/**
 * Send one turn through the exact wiring a phase uses, and say what came back.
 *
 * `npm run llm:probe [--tier heavy|standard|light|all]`
 *
 * The question it answers is "does the provider in .env actually serve a Claude
 * Code session?", which no static check can: the Agent SDK spawns the bundled
 * runtime with the same scrubbed environment every phase gets (BASE_ENV, so the
 * provider's base URL, auth header and alias map), asks for a one-word reply,
 * and prints the runtime's `system`/`result` frames — which model it believes
 * it used, the usage the wire reported, and the stderr if it died. A 401 shows
 * up here as the runtime's own error text, a wrong model id as the provider's,
 * and an endpoint that is not Anthropic-compatible as a session with no frames.
 *
 * Two turns per tier, because a phase needs two things and they fail
 * separately: a plain reply proves the endpoint, the auth header and the model
 * id, and a one-field JSON schema proves structured output — which EVERY phase
 * depends on (src/conductor/schemas.ts) and which a provider can decline while
 * answering ordinary prompts perfectly. A provider that fails the second line
 * cannot run this pipeline, however healthy the first looks.
 *
 * It spends those small calls on whichever provider is configured — on the
 * subscription too, which is why it is a script and not a doctor check.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BASE_ENV, ROOT, llmProvider, modelForTier } from '../src/lib/config.js';
import { TIERS, describeProvider, type Tier } from '../src/lib/provider.js';

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';
const PROBE_TIMEOUT_MS = 120_000;
/**
 * Enough turns for a structured-output round trip. One is enough for a plain
 * reply but not for a schema: the runtime retries a response that does not
 * validate, and a cap of one reports that retry as error_max_turns — a failure
 * of the probe rather than of the provider.
 */
const PROBE_MAX_TURNS = 6;

function tiersToProbe(argv: string[]): Tier[] {
  const i = argv.indexOf('--tier');
  const pick = i === -1 ? 'standard' : (argv[i + 1] ?? 'standard');
  if (pick === 'all') return [...TIERS];
  if ((TIERS as readonly string[]).includes(pick)) return [pick as Tier];
  console.error(`${R}--tier must be one of ${TIERS.join(', ')} or all${X}`);
  process.exit(2);
}

interface ProbeOutcome {
  ok: boolean;
  frames: number;
  servedModel: string;
  subtype: string;
  text: string;
  structured: unknown;
  usage: Record<string, number> | undefined;
  costUsd: number | undefined;
  stderr: string;
  error?: string;
}

/** One required field, so a provider that supports schemas at all can satisfy it. */
const PROBE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean', description: 'always true' } },
};

async function probe(model: string, schema?: Record<string, unknown>): Promise<ProbeOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const out: ProbeOutcome = {
    ok: false, frames: 0, servedModel: '', subtype: '', text: '', structured: undefined,
    usage: undefined, costUsd: undefined, stderr: '',
  };
  try {
    const q = query({
      prompt: schema
        ? 'Return the JSON object {"ok": true} and nothing else.'
        : 'Reply with the single word OK and nothing else.',
      options: {
        model,
        maxTurns: PROBE_MAX_TURNS,
        cwd: ROOT,
        settingSources: [],
        allowedTools: [],
        ...(schema ? { outputFormat: { type: 'json_schema' as const, schema } } : {}),
        env: { ...BASE_ENV },
        abortController: ac,
        stderr: (d: string) => { out.stderr = (out.stderr + d).slice(-4_000); },
      },
    });
    for await (const msg of q) {
      out.frames += 1;
      if (msg.type === 'system' && msg.subtype === 'init') out.servedModel = String(msg.model ?? '');
      if (msg.type === 'result') {
        out.subtype = msg.subtype;
        out.usage = msg.usage as Record<string, number> | undefined;
        out.costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success') {
          out.text = msg.result.trim();
          out.structured = (msg as { structured_output?: unknown }).structured_output;
          out.ok = true;
        }
        else out.error = (msg.errors ?? []).join('; ');
        break;
      }
    }
  } catch (err) {
    out.error = ac.signal.aborted ? `no result within ${PROBE_TIMEOUT_MS / 1000}s` : (err as Error).message;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

async function main(): Promise<void> {
  const provider = llmProvider();
  console.log(`\nOneshot model probe\n  ${describeProvider(provider)}`);
  if (provider.problems.length) {
    for (const p of provider.problems) console.log(`  ${R}FAIL${X}  ${p}`);
    console.log(`\n${R}The provider is not usable; nothing was sent.${X} Fix .env, then \`npm run doctor\`.`);
    process.exit(1);
  }
  for (const n of provider.notes) console.log(`  ${D}note  ${n}${X}`);

  let failed = 0;
  for (const tier of tiersToProbe(process.argv.slice(2))) {
    const model = modelForTier(tier);
    if (!model) { console.log(`  ${R}FAIL${X}  no model for tier ${tier}`); failed += 1; continue; }
    process.stdout.write(`\n  ${tier.padEnd(8)} ${model}\n    reply   … `);
    const r = await probe(model);
    if (r.ok) {
      console.log(`${G}ok${X}  ${JSON.stringify(r.text.slice(0, 40))}`);
    } else {
      failed += 1;
      console.log(`${R}FAIL${X}  ${r.subtype || 'no result frame'}${r.error ? `: ${r.error}` : ''}`);
      if (r.frames === 0) console.log(`            ${D}the runtime emitted no frames at all — endpoint, auth or model id${X}`);
      if (r.stderr.trim()) console.log(`            stderr: ${r.stderr.trim().split('\n').slice(-6).join('\n                    ')}`);
    }
    if (r.servedModel) console.log(`    model   runtime reports ${r.servedModel}`);
    if (r.usage) {
      const u = r.usage;
      console.log(`    usage   in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
        `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}` +
        (typeof r.costUsd === 'number' ? `  est $${r.costUsd.toFixed(4)} (list-price estimate, not a bill)` : ''));
    }

    // Only worth asking once the plain turn worked: otherwise the schema line
    // would report the same endpoint failure a second time.
    if (!r.ok) continue;
    process.stdout.write('    schema  … ');
    const sr = await probe(model, PROBE_SCHEMA);
    const field = (sr.structured as { ok?: unknown } | undefined)?.ok;
    if (sr.ok && field === true) {
      console.log(`${G}ok${X}  structured output honoured`);
    } else {
      failed += 1;
      console.log(`${R}FAIL${X}  ${sr.subtype || sr.error || 'no structured output'}`);
      console.log(`            ${D}every phase returns JSON against a schema, so this provider cannot run a phase${X}`);
      if (sr.structured !== undefined) console.log(`            returned ${JSON.stringify(sr.structured).slice(0, 200)}`);
      else if (sr.text) console.log(`            plain text instead: ${JSON.stringify(sr.text.slice(0, 120))}`);
      if (sr.stderr.trim()) console.log(`            stderr: ${sr.stderr.trim().split('\n').slice(-4).join('\n                    ')}`);
    }
  }
  console.log(failed
    ? `\n${R}${failed} check(s) failed — this provider is not ready for a ticket.${X}`
    : `\n${G}Every check passed: the endpoint answers and honours a schema.${X}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`${R}${(err as Error).message}${X}`); process.exit(1); });
