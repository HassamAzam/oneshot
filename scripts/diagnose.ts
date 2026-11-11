/**
 * `npm run diagnose` — the failure diagnosis, by hand.
 *
 *   npm run diagnose -- <iid>                 diagnose this ticket's stopped run now (one session)
 *   npm run diagnose -- <iid> --post          …and post the note on the ticket
 *   npm run diagnose -- evidence <iid>        print the digest the session would be given (no session, free)
 *   npm run diagnose -- show <iid>            print the recorded diagnosis as the ticket note would read
 *   npm run diagnose -- fix <iid> [D-n]       open a fix pull request for a harness finding (several sessions)
 *   npm run diagnose -- fix <iid> D-n --post  …and say so on the ticket
 *   npm run diagnose -- peek --dir <run dir> frames|frame|grep …
 *
 * The conductor does all of this on its own for a desk that sets
 * ONESHOT_DIAGNOSIS=1 (src/diagnosis/runner.ts). This is for a run it will not
 * pick up: one older than the age limit, one a person wants looked at now, or
 * one copied here from another machine. `evidence` and `show` read a copy
 * wherever it lies (`--dir <run dir>`). The two commands that start sessions
 * do not: a session's transcript and answer are written under
 * state/runs/<iid>, so the copy has to be there.
 *
 * By hand nothing is posted unless `--post` says so, whatever the desk's
 * settings are: a person trying a diagnosis out should not find it on the
 * ticket.
 *
 * `peek` is what a diagnosis SESSION runs to read a transcript. It prints short
 * redacted excerpts with line numbers and never a whole frame, and it loads
 * nothing but the transcript reader, so it starts in a session's bare
 * environment.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);

function usage(code: number): never {
  console.error([
    'usage:',
    '  npm run diagnose -- <iid> [--post]',
    '  npm run diagnose -- evidence <iid> | --dir <run dir>',
    '  npm run diagnose -- show <iid> [--dir <run dir>]',
    '  npm run diagnose -- fix <iid> [finding id] [--post]',
    '  npm run diagnose -- peek --dir <run dir> frames <file> [from] [to]',
    '  npm run diagnose -- peek --dir <run dir> frame <file> <line> [chars]',
    '  npm run diagnose -- peek --dir <run dir> grep <pattern> [file …]',
  ].join('\n'));
  process.exit(code);
}

const iidOf = (v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) usage(2);
  return n;
};

async function peek(rest: string[]): Promise<void> {
  const at = rest.indexOf('--dir');
  if (at < 0 || !rest[at + 1]) usage(2);
  const dir = resolve(rest[at + 1]!);
  const [cmd, ...a] = rest.filter((_, i) => i !== at && i !== at + 1);
  const { frameAt, grepTranscript, listFrames } = await import('../src/diagnosis/transcript.js');
  const { isOwnPhase } = await import('../src/diagnosis/stop.js');
  const path = (f: string): string => (isAbsolute(f) ? f : join(dir, f));
  const must = (f: string | undefined): string => {
    if (!f || !existsSync(path(f))) { console.error(`no such file: ${f ?? '(none given)'}`); process.exit(1); }
    return path(f);
  };

  if (cmd === 'frames') {
    const file = must(a[0]);
    const from = Number(a[1]) || 1;
    // Unbounded, a long transcript is thousands of lines: the window is the point.
    const to = Number(a[2]) || from + 60;
    for (const f of listFrames(file, from, to)) console.log(`${f.line}\t${f.type}\t${f.brief}`);
    return;
  }
  if (cmd === 'frame') {
    const file = must(a[0]);
    // Clamped at both ends: a negative length would slice from the end and print the frame whole.
    const out = frameAt(file, Number(a[1]) || 1, Math.max(200, Math.min(8000, Number(a[2]) || 2000)));
    console.log(out ?? 'that line is not a frame');
    return;
  }
  if (cmd === 'grep') {
    if (!a[0]) usage(2);
    let re: RegExp;
    try { re = new RegExp(a[0]!, 'i'); } catch (err) { console.error(`bad pattern: ${(err as Error).message}`); process.exit(1); }
    const named = a.slice(1);
    const files = named.length
      ? named.map(must)
      // The run's transcripts, not an earlier diagnosis talking about them.
      : readdirSync(join(dir, 'transcripts')).filter((f) => f.endsWith('.jsonl') && !isOwnPhase(f.replace(/-lap\d+\.jsonl$/, '')))
        .sort().map((f) => join(dir, 'transcripts', f));
    let shown = 0;
    for (const file of files) {
      const hits = grepTranscript(file, re, 12);
      const name = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file;
      for (const h of hits) {
        if (shown >= 80) { console.log('… more matches than shown: name a file or tighten the pattern'); return; }
        console.log(`${name}:${h.line}\t${h.type}\t${h.excerpt}`);
        shown += 1;
      }
    }
    if (!shown) console.log('no match');
    return;
  }
  usage(2);
}

async function main(): Promise<void> {
  const [first, ...rest] = args;
  if (!first || first === '-h' || first === '--help') usage(first ? 0 : 2);
  if (first === 'peek') return peek(rest);

  const { runDir, ROOT } = await import('../src/lib/config.js');
  // `--dir <run dir>`: a run directory somewhere else, read where it lies.
  const dirAt = rest.indexOf('--dir');
  const given = dirAt >= 0 && rest[dirAt + 1] ? resolve(rest[dirAt + 1]!) : null;
  const words = rest.filter((_, i) => dirAt < 0 || (i !== dirAt && i !== dirAt + 1));
  const dirOf = (iid: number): string => {
    if (!given) return runDir(iid);
    // A copy is named by hand, and the number beside it is typed by hand too.
    let held: unknown;
    try { held = (JSON.parse(readFileSync(join(given, 'run.json'), 'utf8')) as { iid?: unknown }).iid; } catch { /* no journal: the command says so itself */ }
    if (held !== undefined && held !== iid) { console.error(`${given} holds the run of ticket #${String(held)}, not #${iid}`); process.exit(2); }
    return given;
  };

  if (first === 'evidence') {
    const { buildEvidence, renderEvidence } = await import('../src/diagnosis/evidence.js');
    const { phasePolicies } = await import('../src/diagnosis/runner.js');
    const dir = given ?? runDir(iidOf(words[0]));
    const e = buildEvidence({ dir, policy: phasePolicies(), log: { unavailable: 'not read by `evidence`' } });
    if (!e) { console.error(`no run journal in ${dir}`); process.exit(1); }
    console.log(renderEvidence(e));
    return;
  }

  if (first === 'show') {
    const iid = iidOf(words[0]);
    const { latestDiagnosis, readDiagnosisFile } = await import('../src/diagnosis/record.js');
    const { renderDiagnosisNote } = await import('../src/diagnosis/note.js');
    const stop = latestDiagnosis(readDiagnosisFile(dirOf(iid)));
    if (!stop) { console.error(`no diagnosis recorded for #${iid}`); process.exit(1); }
    console.log(renderDiagnosisNote(stop));
    return;
  }

  // A session writes its transcript and its answer under state/runs/<iid>
  // whatever directory it was pointed at, so a run read from elsewhere would
  // be paid for and its answer never found.
  if (given) {
    console.error(`--dir is for \`evidence\` and \`show\`. To diagnose or fix a copied run, put the copy at ${runDir(iidOf(first === 'fix' ? words[0] : first))} first.`);
    process.exit(2);
  }

  const { ensureClaudeDir } = await import('../src/lib/claudedir.js');
  // The session resolves its skill from .claude in the repo root, which the
  // conductor composes at boot. By hand there may have been no boot.
  ensureClaudeDir(ROOT);

  if (first === 'fix') {
    const iid = iidOf(words[0]);
    const { fixFromDiagnosis } = await import('../src/diagnosis/fix/pipeline.js');
    const outcomes = await fixFromDiagnosis({
      iid, dir: runDir(iid), only: words[1] && !words[1].startsWith('--') ? words[1] : undefined, force: true, post: words.includes('--post'),
    });
    for (const o of outcomes) console.log(o);
    return;
  }

  const iid = iidOf(first);
  const { diagnoseRun, outcomeLine } = await import('../src/diagnosis/runner.js');
  const outcome = await diagnoseRun(iid, { force: true, post: words.includes('--post') });
  console.log(outcomeLine(outcome));
  if (outcome.act === 'diagnosed' || outcome.act === 'superseded') {
    console.log(`\n  npm run diagnose -- show ${iid}     the note as it would read\n  ${join(runDir(iid), 'diagnosis.json')}`);
  }
  process.exit(outcome.act === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
});
