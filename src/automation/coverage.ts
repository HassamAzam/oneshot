/**
 * What already exists for a ticket, gathered by the conductor BEFORE the
 * authoring session runs, so the session writes NEW or EXTENDing cases instead
 * of a fresh full list that repeats what the Cypress suite and the team sheet
 * already cover. The #8420 run wrote sixteen cases where two could fail on the
 * unfixed build, because the session had no way to see that profile_17 already
 * drove the exact path and rows 366.1–366.15 already described it.
 *
 * Two truths, each answering a different question:
 *   - the workstream-automation clone answers "is this automated, and what does
 *     the spec actually check" — the authority for automation. A spec that only
 *     asserts a success toast is NOT coverage of the saved value;
 *   - the team's Workstream_Test_Suite answers "has QA already written a manual
 *     case" — the authority for manual coverage. A "Done" there that no spec
 *     backs is reported as unverified (the LV_55 row says Done; no LV_55 spec
 *     has ever existed), never as coverage.
 *   - the tracker tab is used for ONE thing only: an exact ticket-number hit.
 *     It is missing most tickets, so a miss there says nothing.
 *
 * Every source is optional and wrapped. A clone that is not on this desk
 * (ONESHOT_LOCAL_TESTS_REPO unset), a sheet call that fails, a tracker tab that
 * is not there — each becomes a `notes` line ("coverage not checked: …") and
 * the rest still runs. The gather is READ-ONLY and never throws out to the
 * caller: a coverage step that fails must not hold a ticket (the agreed rule),
 * so `gatherCoverage` always resolves, with its `checked` flags saying what it
 * actually reached.
 *
 * The module derivation and the spec-source parsing are reused from
 * skills/local-tests-impact/scripts/index.cjs — the same deterministic engine
 * the local-tests phase trusts — so "which specs could see this change" is one
 * answer across both modes, not two greps that disagree.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/config.js';
import { getSpreadsheet, getValues, type SheetsResult } from './sheets.js';
import { trackerTitle, type SheetConfig, type TabInfo } from './sheetlayout.js';
import type { AutomationTicket, MergedChange } from './context.js';

const require = createRequire(import.meta.url);
/** The engine's exported internals (untyped .cjs): module derivation and the comment-blanking parser. */
const impact: {
  loadMap: (file?: string) => ImpactMap;
  areaOf: (map: ImpactMap, file: string) => { area: string; kind: string; e2e?: string[]; pages?: string[] };
  stripComments: (src: string, blankStrings?: boolean) => string;
} = require(join(ROOT, 'skills', 'local-tests-impact', 'scripts', 'index.cjs'));

interface ImpactMap { frontend: unknown; backend: unknown; shared: unknown; uncovered: unknown }

// ------------------------------------------------------------------ shapes

/** One existing Cypress spec that could see this change, and what it checks. */
export interface SpecCoverage {
  /** Repo-relative, e.g. cypress/e2e/profileA/profile_17_….ts */
  file: string;
  /** The cypress/e2e module folder it lives in. */
  module: string;
  /**
   * How sure the hit is. `phrase` = the spec names this change's label or
   * constant (strong: it probably drives it). `module` = it only lives in the
   * change's module folder (weak: it runs in this area but may test something
   * else entirely). The two are shown differently so a whole module's worth of
   * unrelated specs is never mistaken for coverage of this change.
   */
  strength: 'phrase' | 'module';
  /** How it was found: the term it matched, or the module it lives in. One short phrase. */
  why: string;
  /** The describe/it titles — the plainest statement of what the spec checks. */
  checks: string[];
  /** Hints at the DEPTH of the check: does it re-read (reload/visit) and assert, or only a toast? */
  reloads: boolean;
  assertions: number;
}

/** Manual cases the team sheet already lists for this area. */
export interface SheetCoverage {
  tab: string;
  /** Matching rows, each "<ref>: <scenario>" trimmed to one line. */
  rows: string[];
}

/** An exact ticket-number hit on a tracker tab — the only thing the tracker is trusted for. */
export interface TrackerHit {
  tab: string;
  row: number;
  /** The row joined to one line, for the reader to judge. */
  text: string;
}

export interface CoverageReport {
  /** What was actually reached. A false flag means "not checked", never "nothing found". */
  checked: { cypress: boolean; sheet: boolean; tracker: boolean };
  /** The search terms and modules the gather derived — shown so a reviewer can see what it looked for. */
  terms: string[];
  modules: string[];
  specs: SpecCoverage[];
  sheet: SheetCoverage[];
  tracker: TrackerHit[];
  /** "coverage not checked: …" and other one-line caveats. */
  notes: string[];
}

export interface CoverageInput {
  iid: number;
  ticket: AutomationTicket;
  changes: MergedChange[];
  /** The workstream-automation clone (localTestsConfig().repo). '' or missing → the Cypress half is skipped. */
  repo?: string;
  /** The sheet to read manual coverage from. Absent → the sheet and tracker halves are skipped. */
  sheet?: {
    cfg: SheetConfig;
    saFile: string;
    /** listModuleTabs output, reused so the gather does not fetch the tab list twice. */
    modules: Array<{ tab: string; module: string }>;
  };
  /** The year whose tracker tab to read. The caller passes the approval year. */
  year: number;
}

// ------------------------------------------------------------------ term derivation (pure)

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'should', 'able', 'verify',
  'user', 'users', 'bug', 'fix', 'fixed', 'issue', 'page', 'button', 'field', 'error', 'not',
  'add', 'added', 'remove', 'removed', 'update', 'updated', 'change', 'changed', 'show', 'shown',
  'display', 'displayed', 'able', 'into', 'their', 'there', 'here', 'does', 'doesn', 'will',
]);

/** The ticket number as GitLab writes it in a tracker cell or URL, so a hit is the ticket and not a coincidence. */
function ticketPatterns(iid: number): RegExp[] {
  return [
    new RegExp(`(^|[^0-9])#${iid}([^0-9]|$)`),
    new RegExp(`/issues/${iid}([^0-9]|$)`),
    new RegExp(`(^|[^0-9])${iid}([^0-9]|$)`),
  ];
}

/** A changed file's stem if it reads like a code identifier (person_approver, finalSettlement) worth searching for. */
function fileSymbol(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');
  if (base.length < 5) return null;
  if (/^(index|views|models|serializers|urls|utils|admin|tests|init|main|app)$/i.test(base)) return null;
  return /^[A-Za-z][\w-]*$/.test(base) ? base : null;
}

/**
 * The strings the gather searches for, in three strengths:
 *   - `phrases`: quoted multi-word labels from the ticket ("Blocked Notifications") and changed
 *     code identifiers. Distinctive enough to match a spec ANYWHERE in the suite;
 *   - `words`: single meaningful words from the title. Matched only INSIDE a module's own folder,
 *     because "profile" alone would pull in half the suite.
 * Deduped and lower-cased; the title's own tag suffix ("[Profile] …") is dropped first.
 *
 * The specs name a label as a CONSTANT (`BlockedNotificationType.AUTOMATED_BIRTHDAY_WISH_NOTIFICATION`),
 * not as the human string, so a Title-Case run in the title ("Blocked Team Updates") is kept as a
 * phrase too: normalised, it meets the constant on one string (see normalizeTokens).
 */
export function deriveTerms(ticket: AutomationTicket, changes: MergedChange[]): { phrases: string[]; words: string[] } {
  const title = ticket.title.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  const text = `${title}\n${ticket.description ?? ''}`;
  const phrases = new Set<string>();
  const add = (p: string): void => {
    const v = p.trim().toLowerCase();
    if (v.length >= 4 && /\s/.test(v) && !/^https?:/i.test(v)) phrases.add(v);
  };
  // Quoted labels in the ticket text.
  for (const m of text.matchAll(/["'“”‘’«»`]([^"'“”‘’«»`]{3,60})["'“”‘’«»`]/g)) add(m[1]!);
  // Title-Case runs of two or more words in the title (feature names: "Blocked Notifications").
  for (const m of title.matchAll(/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|and|of|the|to))*\s+[A-Z][a-z]+)\b/g)) {
    add(m[1]!.replace(/\s+(and|of|the|to)\s+/g, ' '));
  }
  // Changed-file identifiers (person_approver, finalSettlement).
  for (const c of changes) {
    for (const f of c.files) {
      const sym = fileSymbol(f.new_path || f.old_path);
      if (sym) phrases.add(sym.toLowerCase());
    }
  }
  const words = new Set<string>();
  for (const w of title.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!STOP.has(w)) words.add(w);
  }
  return { phrases: [...phrases], words: [...words] };
}

/**
 * Lower-case words, with `_`, camelCase and punctuation all turned to single
 * spaces, so a spec's `AUTOMATED_BIRTHDAY_WISH_NOTIFICATION` and a ticket's
 * "Automated birthday wish notification" become the same string and a phrase
 * search finds the spec that a raw substring match would miss.
 */
export function normalizeTokens(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ module derivation (pure)

/**
 * The cypress/e2e module folders the change's files map to, through the same
 * modules-map the local-tests phase uses. A file in shared backend code
 * (apps/core, apps/users) maps to no module — recorded as a note so the gather
 * leans on term search there and the reader knows why it is thin.
 */
export function deriveModules(
  changes: MergedChange[],
  map: ImpactMap,
): { e2e: string[]; notes: string[] } {
  const e2e = new Set<string>();
  const sharedAreas = new Set<string>();
  for (const c of changes) {
    for (const f of c.files) {
      const path = f.new_path || f.old_path;
      if (!path) continue;
      let a;
      try { a = impact.areaOf(map, path); } catch { continue; }
      if (a.kind === 'mapped' && a.e2e) for (const m of a.e2e) e2e.add(m);
      else if (a.kind === 'shared') sharedAreas.add(a.area);
    }
  }
  const notes: string[] = [];
  if (sharedAreas.size) {
    notes.push(`the change touches shared code (${[...sharedAreas].sort().join(', ')}), which maps to no one `
      + 'module — specs were searched by term, which can miss a screen that only renders it');
  }
  return { e2e: [...e2e].sort(), notes };
}

// ------------------------------------------------------------------ spec reading (pure + fs)

/** Every `cypress/e2e/**` spec, repo-relative, sorted. Returns [] when the folder is not there. */
function specFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try { entries = readdirSync(join(repo, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.[jt]s$/.test(e.name)) out.push(r);
    }
  };
  walk('cypress/e2e');
  return out.sort();
}

/**
 * The describe/it titles and the assertion shape of one spec source. Pure.
 *
 * Assertions are counted broadly, because this suite asserts through custom
 * commands (`getSuccessToast`, `verify…`), not only Cypress's own `.should`.
 * `reloads` is the depth signal that matters most: a spec that re-reads the
 * page (reload or re-visit) and asserts has checked the SAVED value; one that
 * only asserts a toast right after Save has not, so a case that reloads still
 * earns its place.
 */
export function specChecks(src: string): { checks: string[]; reloads: boolean; assertions: number } {
  const clean = impact.stripComments(src);
  const checks: string[] = [];
  for (const m of clean.matchAll(/\b(?:it|describe|context|specify)\s*\(\s*(['"`])([^'"`]{1,200})\1/g)) {
    const t = m[2]!.trim();
    if (t) checks.push(t);
  }
  const reloads = /\bcy\.reload\b|\.reload\(|\bcy\.visit\(|\.visit\(/.test(clean);
  const assertions = (clean.match(
    /\.should\(|\bexpect\(|\.contains\(|getSuccessToast|\.(?:verify|assert|check|expect|haveText|beVisible)[A-Za-z]*\(/g,
  ) ?? []).length;
  return { checks: [...new Set(checks)], reloads, assertions };
}

/** At most this many strong (phrase) hits, and this many weak (module-only) specs, in the block. */
const PHRASE_CAP = 15;
const MODULE_CAP = 8;

/**
 * Specs that could see this change, in two strengths:
 *   - **phrase**: the spec names this change's label or constant (matched after
 *     token-normalising, so `AUTOMATED_BIRTHDAY_WISH_NOTIFICATION` meets
 *     "Automated birthday wish notification"). A strong hit — it probably drives
 *     the change, and its depth decides whether a new case is still needed.
 *   - **module**: the spec only lives in the change's module folder. A weak hit
 *     — it runs in this area but may test something else; kept few and labelled,
 *     because a Blocked-Notifications fix is not covered by every Profile spec.
 * Phrase hits come first; module-only hits fill a small remainder.
 */
export function candidateSpecs(
  repo: string,
  e2e: string[],
  terms: { phrases: string[]; words: string[] },
): SpecCoverage[] {
  const files = specFiles(repo);
  const modules = new Set(e2e);
  const phrases = terms.phrases.map((p) => normalizeTokens(p)).filter((p) => p.length >= 4);
  const phraseHits: SpecCoverage[] = [];
  const moduleHits: SpecCoverage[] = [];
  for (const file of files) {
    const folder = file.split('/')[2] ?? '';
    const inModule = modules.has(folder);
    if (!inModule && !phrases.length) continue;
    let src = '';
    try { src = readFileSync(join(repo, file), 'utf8'); } catch { continue; }
    const norm = `${normalizeTokens(file)} ${normalizeTokens(src)}`;
    const phraseHit = phrases.find((p) => norm.includes(p));
    if (!inModule && !phraseHit) continue;
    const { checks, reloads, assertions } = specChecks(src);
    if (phraseHit) {
      phraseHits.push({ file, module: folder, strength: 'phrase', why: `names "${phraseHit}"`, checks, reloads, assertions });
    } else {
      moduleHits.push({ file, module: folder, strength: 'module', why: `in module ${folder}`, checks, reloads, assertions });
    }
  }
  return [...phraseHits.slice(0, PHRASE_CAP), ...moduleHits.slice(0, MODULE_CAP)];
}

// ------------------------------------------------------------------ sheet reading (io)

/** First column that looks like a case ref (121, 366.1, LV_55), else the row's first non-empty cell. */
function rowRef(row: string[]): string {
  const ref = row.find((c) => /^[A-Za-z]{0,4}[_-]?\d+(\.\d+)?$/.test(c.trim()) && c.trim() !== '');
  return (ref ?? row.find((c) => c.trim() !== '') ?? '').trim();
}

/**
 * The sheet module tabs worth reading, most relevant first. A tab is chosen by
 * its MODULE NAME, scored: the ticket's label naming it beats a loose title
 * word, and a bare title word ("team" from "Blocked Team Updates") never pulls
 * in a whole different module's tab (Team Management) — that was dropping the
 * ticket's own Profile tab when the list was capped. Top three, bounded so the
 * gather reads a few tabs, not all thirty.
 */
export function tabsToSearch(
  modules: Array<{ tab: string; module: string }>,
  labels: string[],
  terms: { phrases: string[]; words: string[] },
): string[] {
  const labelSet = new Set(labels.map((l) => l.toLowerCase().trim()));
  const titleWords = new Set(terms.words);
  const scored = modules
    .map((m) => {
      const name = m.module.toLowerCase().trim();
      let score = 0;
      if (labelSet.has(name)) score += 3;
      else if ([...labelSet].some((l) => l === name || l.includes(` ${name}`) || l.includes(`${name} `))) score += 2;
      if (titleWords.has(name)) score += 1; // the whole module name is a title word, not merely part of one
      return { tab: m.tab, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((x) => x.tab))].slice(0, 3);
}

const SHEET_ROW_CAP = 12;

async function readSheetRows(
  cfg: SheetConfig,
  saFile: string,
  tabs: string[],
  terms: { phrases: string[]; words: string[] },
): Promise<{ sheet: SheetCoverage[]; notes: string[] }> {
  const sheet: SheetCoverage[] = [];
  const notes: string[] = [];
  const needles = [...terms.phrases, ...terms.words].map((s) => s.toLowerCase()).filter((s) => s.length >= 4);
  for (const tab of tabs) {
    const g: SheetsResult<string[][]> = await getValues(cfg.spreadsheetId, `'${tab.replace(/'/g, "''")}'!A1:Z`, saFile);
    if (!g.ok) { notes.push(`coverage not checked: could not read the sheet tab '${tab}' (${g.kind})`); continue; }
    const rows: string[] = [];
    for (const [i, row] of g.data.entries()) {
      const line = row.join(' ').toLowerCase();
      if (needles.some((n) => line.includes(n))) {
        const text = `${rowRef(row)}: ${row.filter((c) => c.trim()).join(' | ')}`.replace(/\s+/g, ' ').trim();
        rows.push(`row ${i + 1} — ${text.slice(0, 240)}`);
        if (rows.length >= SHEET_ROW_CAP) break;
      }
    }
    if (rows.length) sheet.push({ tab, rows });
  }
  return { sheet, notes };
}

async function readTracker(
  cfg: SheetConfig,
  saFile: string,
  iid: number,
  year: number,
): Promise<{ tracker: TrackerHit[]; checked: boolean; notes: string[] }> {
  const tracker: TrackerHit[] = [];
  const notes: string[] = [];
  const pats = ticketPatterns(iid);
  // The approval year and the one before it: a ticket written up in December lands on either.
  for (const y of [year, year - 1]) {
    const tab = trackerTitle(cfg.trackerTab, y);
    const g = await getValues(cfg.spreadsheetId, `'${tab.replace(/'/g, "''")}'!A1:Z`, saFile);
    if (!g.ok) {
      // A tab that is not there (a year with no tracker yet) reads as a bad range
      // (client) or not-found, and is not a failure; a transport or auth error is.
      if (g.kind !== 'client' && g.kind !== 'notfound') {
        notes.push(`coverage not checked: could not read the tracker '${tab}' (${g.kind})`);
      }
      continue;
    }
    for (const [i, row] of g.data.entries()) {
      const line = row.join(' ');
      if (pats.some((p) => p.test(line))) {
        tracker.push({ tab, row: i + 1, text: row.filter((c) => c.trim()).join(' | ').replace(/\s+/g, ' ').slice(0, 240) });
      }
    }
  }
  return { tracker, checked: true, notes };
}

// ------------------------------------------------------------------ orchestration

/**
 * Gather the coverage, one source at a time, never throwing. A source that is
 * off or fails sets its `checked` flag false and leaves a note; the caller
 * carries on (the agreed rule: a coverage miss marks the cases "coverage not
 * checked", it does not hold the ticket).
 */
export async function gatherCoverage(input: CoverageInput): Promise<CoverageReport> {
  const terms = deriveTerms(input.ticket, input.changes);
  const report: CoverageReport = {
    checked: { cypress: false, sheet: false, tracker: false },
    terms: [...terms.phrases, ...terms.words],
    modules: [],
    specs: [],
    sheet: [],
    tracker: [],
    notes: [],
  };

  // Cypress: the clone on this desk, if ONESHOT_LOCAL_TESTS_REPO is set.
  if (input.repo) {
    try {
      const map = impact.loadMap();
      const mods = deriveModules(input.changes, map);
      report.modules = mods.e2e;
      report.notes.push(...mods.notes);
      report.specs = candidateSpecs(input.repo, mods.e2e, terms);
      report.checked.cypress = true;
    } catch (err) {
      report.notes.push(`coverage not checked: could not read the Cypress clone (${(err as Error).message})`);
    }
  } else {
    report.notes.push('coverage not checked: no workstream-automation clone on this desk (ONESHOT_LOCAL_TESTS_REPO unset)');
  }

  // Sheet + tracker: the team's Workstream_Test_Suite, if the sheet is configured.
  if (input.sheet) {
    const { cfg, saFile, modules } = input.sheet;
    try {
      const tabs = tabsToSearch(modules, input.ticket.labels, terms);
      if (tabs.length) {
        const r = await readSheetRows(cfg, saFile, tabs, terms);
        report.sheet = r.sheet;
        report.notes.push(...r.notes);
        report.checked.sheet = r.notes.length === 0 || r.sheet.length > 0;
      } else {
        report.notes.push('the sheet was not searched for manual cases: no module tab matched the ticket');
        report.checked.sheet = true;
      }
    } catch (err) {
      report.notes.push(`coverage not checked: the sheet could not be read (${(err as Error).message})`);
    }
    try {
      const t = await readTracker(cfg, saFile, input.iid, input.year);
      report.tracker = t.tracker;
      report.notes.push(...t.notes);
      report.checked.tracker = t.checked;
    } catch (err) {
      report.notes.push(`coverage not checked: the tracker could not be read (${(err as Error).message})`);
    }
  } else {
    report.notes.push('coverage not checked: the test-case sheet is not configured on this desk');
  }

  return report;
}

// ------------------------------------------------------------------ rendering

function specLine(s: SpecCoverage): string {
  const depth = s.reloads
    ? `re-reads the page and asserts (${s.assertions} checks)`
    : s.assertions
      ? `asserts without re-reading (${s.assertions} checks) — may only check the immediate response (a toast), not the saved value`
      : 'no assertion detected';
  const checks = s.checks.length ? ` — it(): ${s.checks.map((c) => `"${c}"`).join('; ').slice(0, 300)}` : '';
  return `- \`${s.file}\` (${s.why}; ${depth})${checks}`;
}

/**
 * The block the prompt and the QA comment both read. Facts only, from the
 * trusted clone and sheet — not the session's guesses. When nothing was found
 * on a reached source, it says so, because "found nothing" and "did not look"
 * must not read the same.
 */
export function renderCoverage(r: CoverageReport): string {
  const out: string[] = ['## What already exists',
    'Checked by the conductor before this session, from the Cypress clone (what is automated and '
    + 'what each spec actually checks) and the team test-case sheet (what QA has written down). '
    + 'This is authoritative — do not re-derive it. Use it to write NEW or EXTENDing cases only.'];

  if (r.checked.cypress) {
    const phrase = r.specs.filter((s) => s.strength === 'phrase');
    const moduleOnly = r.specs.filter((s) => s.strength === 'module');
    if (phrase.length) {
      out.push(`### Cypress specs that name this change (${phrase.length})`);
      out.push(phrase.map(specLine).join('\n'));
      out.push('A spec that only asserts a success toast (no re-read) does NOT cover the saved value: a case '
        + 'that reloads and checks the stored result still earns its place, phrased as extending that spec.');
    } else {
      out.push('### Cypress specs\nNo spec names this change directly. Treat the cases as NEW unless a '
        + 'same-module spec below already drives it.');
    }
    if (moduleOnly.length) {
      out.push(`### Other specs in the same module(s) (${moduleOnly.length})`);
      out.push('These run in the change\'s area but may test something else — check before assuming they cover it:\n'
        + moduleOnly.map((s) => `- \`${s.file}\`${s.checks[0] ? ` — "${s.checks[0]}"` : ''}`).join('\n'));
    }
  }

  if (r.checked.sheet) {
    if (r.sheet.length) {
      out.push('### Manual cases already on the team sheet');
      out.push(r.sheet.map((s) => `**${s.tab}**\n${s.rows.map((x) => `- ${x}`).join('\n')}`).join('\n\n'));
      out.push('A sheet row marked Done that no Cypress spec above backs is UNVERIFIED coverage, not proof: '
        + 'trust the clone, and note the mismatch in `summary` for QA.');
    } else {
      out.push('### Manual cases on the team sheet\nNo matching row was found.');
    }
  }

  if (r.checked.tracker && r.tracker.length) {
    out.push('### Tracker');
    out.push(r.tracker.map((t) => `- ${t.tab} row ${t.row}: ${t.text}`).join('\n'));
  }

  if (r.modules.length) out.push(`_Modules the change maps to: ${r.modules.join(', ')}. Terms searched: ${r.terms.slice(0, 12).join(', ') || 'none'}._`);
  if (r.notes.length) out.push(`_Caveats: ${r.notes.join('; ')}._`);

  out.push('How to use this: do not write a case for behaviour a spec above already asserts after a re-read — '
    + 'extend it instead, and say so in `summary`. Write a NEW case only where nothing above covers the behaviour. '
    + 'For a bug fix this usually means one or two cases, not a fresh full list.');
  return out.join('\n\n');
}

/**
 * The short line(s) for the QA comment: what was checked, and the one thing QA
 * must know. Plain sentences — the comment renderer wraps them and escapes
 * them — with identifiers in backticks so a tab like `TestCases_Profile` cannot
 * read as markdown emphasis.
 */
export function coverageNote(r: CoverageReport): string[] {
  const out: string[] = [];
  const found: string[] = [];
  const named = r.specs.filter((s) => s.strength === 'phrase').length;
  if (r.checked.cypress) found.push(named ? `${named} Cypress spec(s) that name this change` : 'no Cypress spec names this change');
  if (r.checked.sheet) found.push(r.sheet.length ? `manual rows on ${r.sheet.map((s) => `\`${s.tab}\``).join(', ')}` : 'no matching sheet row');
  if (found.length) {
    out.push(`Existing coverage checked: ${found.join('; ')}. New cases below extend or avoid it.`);
  }
  const notChecked = [!r.checked.cypress && 'Cypress', !r.checked.sheet && 'the sheet'].filter(Boolean);
  if (notChecked.length) out.push(`Coverage not checked against ${notChecked.join(' or ')} on this desk, so the list may repeat existing cases.`);
  return out;
}
