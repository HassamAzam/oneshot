/**
 * The delivery-zone guard: stop a run whose files leave the zone it was routed for.
 *
 * The ERP repo carries a zone map (`.claude/zones.json`, drawn and merged by a
 * person): green areas Oneshot may change in a tight loop, yellow areas only
 * once characterization tests have landed, red areas never. Triage routes by
 * what the ticket TEXT names; this guard checks what the run actually PLANS
 * and TOUCHES, because "implementation should stop if it discovers the map was
 * wrong" — a 'payroll' bug fixed in a shared util is exactly that case.
 *
 * It applies only to tickets carrying the routing label (`AI`), i.e. tickets
 * the Plane pipeline sent here by zone. A ticket a person labelled `Loop` by
 * hand keeps today's behaviour: the review gates, not a stop.
 *
 * The map is read from the work repo's origin/<base>, never from the ticket's
 * worktree, so a branch cannot widen its own zone by editing the map.
 */
import { execFileSync } from 'node:child_process';
import { WORK_REPO, projectConfig, type ProjectConfig } from '../lib/config.js';

/**
 * The `zones` block of config/project.json, or null when there is none.
 *
 * The functions that read the block take it as a defaulted last argument
 * rather than only reading the live config, because it is absent in the
 * shipped config (the guard is switched off until the map is on the base
 * branch). Tests that read the live switch would test nothing while it is off
 * and break the day it is turned on; they pass a fixture instead.
 */
export type ZonesConfig = NonNullable<ProjectConfig['zones']>;
const liveZones = (): ZonesConfig | null => projectConfig().zones ?? null;

export interface ZoneArea { name: string; zone: string; paths: string[] }
export interface ZoneMap { severity: string[]; default_zone: string; areas: ZoneArea[] }
export interface ZoneHit { file: string; zone: string; areas: string[] }
export interface ZoneVerdict {
  applies: boolean;
  violations: ZoneHit[];
  /** Why the guard could not judge the files at all, or null when it could. Non-null stops the run. */
  unreadable: string | null;
}
/** What reading the map gave: the map, or why there is none, in words a person can act on. */
export type ZoneMapRead = { map: ZoneMap } | { error: string };
/** Where the guard reads git: the shared work repo and the base branch, overridable for tests. */
export interface GitSource { repo?: string; base?: string }

/** zones.json path rules: 'dir/' is a prefix, '**\/name' matches anywhere, anything else is exact. */
export function matches(pattern: string, path: string): boolean {
  if (pattern.startsWith('**/')) {
    const name = pattern.slice(3);
    return path === name || path.endsWith('/' + name) || `/${path}`.includes(`/${name.replace(/\/$/, '')}/`);
  }
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  return path === pattern;
}

/** The most severe zone over every area a file falls in; no area means default_zone. */
export function zoneOf(map: ZoneMap, file: string): ZoneHit {
  const hits = map.areas.filter((a) => a.paths.some((p) => matches(p, file)));
  if (!hits.length) return { file, zone: map.default_zone, areas: [] };
  const worst = hits.reduce((w, a) => (map.severity.indexOf(a.zone) > map.severity.indexOf(w.zone) ? a : w));
  return { file, zone: worst.zone, areas: hits.map((a) => a.name) };
}

/**
 * Why Oneshot must not run this ticket at all, or null.
 *
 * A characterization-test ticket pins today's behaviour so that a LATER agent
 * change can be judged against it. If the agent wrote those tests too, the
 * suite would only confirm whatever the agent decided — so these are a
 * person's work, whatever other labels the ticket carries.
 */
export function refusedTicket(labels: string[], zones: ZonesConfig | null = liveZones()): string | null {
  const label = zones?.testsLabel;
  if (!label || !labels.includes(label)) return null;
  return `"${label}" tickets are written by a person, never Oneshot — remove Loop; the change is released when these merge`;
}

/** Whether this ticket was routed by zone, and so is held to its zone. */
export function zoneGuardApplies(labels: string[], zones: ZonesConfig | null = liveZones()): boolean {
  const label = zones?.guardLabel;
  return Boolean(label) && labels.includes(label!);
}

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

/** What is wrong with one entry of `areas`, or null. */
function areaProblem(item: unknown, severity: string[]): string | null {
  const a = (item ?? {}) as Partial<Record<keyof ZoneArea, unknown>>;
  if (typeof a.name !== 'string' || !a.name) return 'has no name';
  if (typeof a.zone !== 'string' || !severity.includes(a.zone)) {
    return `has zone ${JSON.stringify(a.zone)}, which is not one of \`severity\``;
  }
  if (!isStrings(a.paths) || !a.paths.length) return 'has no paths';
  const unmatched = a.paths.find((p) => !p || p.replace(/^\*\*\//, '').includes('*'));
  if (unmatched !== undefined) {
    return `has path ${JSON.stringify(unmatched)}, which the guard cannot match `
      + "(only 'dir/', '**/name' and exact paths)";
  }
  return null;
}

/**
 * The map's shape, checked field by field before the guard trusts it.
 *
 * The `as ZoneMap` cast this replaces checked only that `areas` and `severity`
 * were arrays, and four mistakes in a hand-written map got through it. An area
 * whose zone is not in `severity` (a typo'd "Red") ranks -1, so an overlapping
 * green area outranked it and the file PASSED: the guard failed open. An area
 * with no `paths` threw out of runTicket, where nothing called finish(), so the
 * ticket kept Loop with no note and threw again on every scan. A missing
 * `default_zone` put "(undefined)" in the stop reason. And a pattern such as
 * `apps/*\/permissions.py` or `*.sql` never matches under matches(), so its
 * files fell silently to the default zone. Each is a map the guard cannot judge
 * by, so each fails closed, naming the first problem found.
 */
export function validateZoneMap(raw: unknown): ZoneMapRead {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'it is not a JSON object' };
  const m = raw as Record<string, unknown>;
  const severity = m.severity;
  if (!isStrings(severity) || !severity.length) return { error: '`severity` is not a list of zone names' };
  if (!severity.includes('green')) return { error: '`severity` has no "green"' };
  if (typeof m.default_zone !== 'string' || !severity.includes(m.default_zone)) {
    return { error: `\`default_zone\` ${JSON.stringify(m.default_zone)} is not one of \`severity\`` };
  }
  if (!Array.isArray(m.areas)) return { error: '`areas` is not a list' };
  for (const [k, item] of m.areas.entries()) {
    const problem = areaProblem(item, severity);
    if (!problem) continue;
    const name = (item as { name?: unknown } | null)?.name;
    return { error: `area ${typeof name === 'string' && name ? `"${name}"` : `#${k + 1}`} ${problem}` };
  }
  return { map: m as unknown as ZoneMap };
}

/**
 * Bring origin/<base> in the shared work repo up to date, if git can.
 *
 * Best effort on purpose. The ref was fetched when some worktree was last
 * leased, which can be long ago; a map merged since then would read as missing.
 * But a failed fetch (the network, or a concurrent fetch holding the ref lock)
 * is not a verdict: the ref still answers, and whatever reads it next reports
 * honestly if it cannot.
 */
function fetchBase(repo: string, base: string): void {
  try {
    execFileSync('git', ['-C', repo, 'fetch', '--no-tags', '--quiet', 'origin', base],
      { timeout: 60_000, stdio: 'ignore' });
  } catch {
    // See the docstring: the ref already present is what gets read.
  }
}

/**
 * Read the merged map from the work repo's origin/<base>, or say why it cannot be.
 *
 * "Missing" and "invalid" are told apart because they need different people.
 * The first reason this guard ever gave was "zone map unreadable — fetch
 * origin" for a map that was not on dev at all (arbisoft/erp!11060 had not
 * merged), which sent a person to a fetch that could not help. git's own
 * stderr is what tells the cases apart, so it is kept, not discarded.
 */
export function loadZoneMap(
  file: string | undefined = liveZones()?.file,
  { repo = WORK_REPO, base = projectConfig().branches.base }: GitSource = {},
): ZoneMapRead {
  if (!file) return { error: 'no zone map file is configured (zones.file is empty)' };
  if (!repo) return { error: `WORK_REPO is not set, so zone map ${file} cannot be read` };
  fetchBase(repo, base);
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', repo, 'show', `origin/${base}:${file}`],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (/does not exist in|exists on disk, but not in/.test(stderr)) {
      return { error: `zone map ${file} is not on origin/${base} — merge it there` };
    }
    const line = stderr.split('\n').find((l) => l.trim()) ?? (err as Error).message;
    return { error: `zone map ${file} cannot be read from origin/${base} (${line.trim()})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `zone map ${file} on origin/${base} is not valid JSON — fix it by MR` };
  }
  const read = validateZoneMap(parsed);
  if ('error' in read) return { error: `zone map ${file} on origin/${base} is invalid: ${read.error} — fix it by MR` };
  return read;
}

/**
 * Which of `files` this ticket may not touch.
 *
 * Green is always allowed. Yellow is allowed only on a ticket that carries the
 * yellow release label — grooming puts it on a change whose characterization
 * tests merged first. Red never is. Without the guard label nothing applies.
 */
export function zoneVerdict(
  labels: string[], files: string[], read: ZoneMapRead, zones: ZonesConfig | null = liveZones(),
): ZoneVerdict {
  const applies = zoneGuardApplies(labels, zones);
  if (!applies) return { applies, violations: [], unreadable: null };
  if ('error' in read) return { applies, violations: [], unreadable: read.error };
  const { map } = read;
  const yellow = zones?.yellowLabel;
  const allowed = new Set(['green', ...(yellow && labels.includes(yellow) ? ['yellow'] : [])]);
  const seen = new Set<string>();
  const violations = files
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)))
    .map((f) => zoneOf(map, f))
    .filter((hit) => !allowed.has(hit.zone));
  return { applies, violations, unreadable: null };
}

/** The stop reason posted on the ticket: which files, which zone, and what a person can do. */
export function zoneBlockReason(verdict: ZoneVerdict, zones: ZonesConfig | null = liveZones()): string {
  if (verdict.unreadable) {
    return `${verdict.unreadable}, or remove ${zones?.guardLabel || 'AI'} to run under the review gates`;
  }
  const shown = verdict.violations.slice(0, 8)
    .map((v) => `${v.file} (${v.zone}${v.areas.length ? `: ${v.areas.join(', ')}` : ''})`).join('; ');
  const more = verdict.violations.length > 8 ? ` +${verdict.violations.length - 8} more` : '';
  return `outside its zone: ${shown}${more}. Re-plan inside the zone, hand it to the team, or change .claude/zones.json by MR`;
}
