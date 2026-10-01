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
export interface ZoneVerdict { applies: boolean; violations: ZoneHit[]; unreadable: boolean }

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

/** Read the merged map from the work repo; null when it cannot be read. */
export function loadZoneMap(): ZoneMap | null {
  const z = projectConfig().zones;
  if (!z?.file || !WORK_REPO) return null;
  try {
    const raw = execFileSync('git', ['-C', WORK_REPO, 'show', `origin/${projectConfig().branches.base}:${z.file}`],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const map = JSON.parse(raw) as ZoneMap;
    return Array.isArray(map.areas) && Array.isArray(map.severity) ? map : null;
  } catch {
    return null;
  }
}

/**
 * Which of `files` this ticket may not touch.
 *
 * Green is always allowed. Yellow is allowed only on a ticket that carries the
 * yellow release label — grooming puts it on a change whose characterization
 * tests merged first. Red never is. Without the guard label nothing applies.
 */
export function zoneVerdict(
  labels: string[], files: string[], map: ZoneMap | null, zones: ZonesConfig | null = liveZones(),
): ZoneVerdict {
  const applies = zoneGuardApplies(labels, zones);
  if (!applies) return { applies, violations: [], unreadable: false };
  if (!map) return { applies, violations: [], unreadable: true };
  const yellow = zones?.yellowLabel;
  const allowed = new Set(['green', ...(yellow && labels.includes(yellow) ? ['yellow'] : [])]);
  const seen = new Set<string>();
  const violations = files
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)))
    .map((f) => zoneOf(map, f))
    .filter((hit) => !allowed.has(hit.zone));
  return { applies, violations, unreadable: false };
}

/** The stop reason posted on the ticket: which files, which zone, and what a person can do. */
export function zoneBlockReason(verdict: ZoneVerdict): string {
  if (verdict.unreadable) return 'zone map unreadable — fetch origin, or remove AI to run under the review gates';
  const shown = verdict.violations.slice(0, 8)
    .map((v) => `${v.file} (${v.zone}${v.areas.length ? `: ${v.areas.join(', ')}` : ''})`).join('; ');
  const more = verdict.violations.length > 8 ? ` +${verdict.violations.length - 8} more` : '';
  return `outside its zone: ${shown}${more}. Re-plan inside the zone, hand it to the team, or change .claude/zones.json by MR`;
}
