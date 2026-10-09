/**
 * Saved eval scores, one JSON file per scoring, committed under evals/history/<kind>/,
 * named <local date>T<HHMM>-<label>.json; `at` inside keeps the exact UTC time.
 *
 * A gold file is the answer key and never changes with a prompt; the scores do.
 * Each saved scoring names the Oneshot commit and a label (`prompt-a`,
 * `tc-boundary-pass`), so prompt A, B and C stay comparable after the run
 * artifacts they were graded from have been overwritten. state/ is per machine
 * and gitignored, so it cannot hold this.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Saved<T> { label: string; at: string; oneshot: string; mode: 'live' | 'replay'; data: T }

export function historyDir(root: string, kind: string): string {
  return join(root, 'evals', 'history', kind);
}

export function saveHistory<T>(root: string, kind: string, label: string, mode: Saved<T>['mode'], data: T): string {
  const dir = historyDir(root, kind);
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const oneshot = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace(/:/g, '');
  const file = join(dir, `${local}-${label.replace(/[^\w.-]+/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ label, at, oneshot, mode, data } satisfies Saved<T>, null, 2)}\n`);
  return file;
}

/** The newest saved scoring of this kind, or the one whose label is `label`. */
export function loadHistory<T>(root: string, kind: string, label?: string): Saved<T> | null {
  const dir = historyDir(root, kind);
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Saved<T>);
  const pick = label ? all.filter((s) => s.label === label) : all;
  return pick.at(-1) ?? null;
}

export function argValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}
