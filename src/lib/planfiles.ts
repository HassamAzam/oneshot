/**
 * A plan's `fileChanges`, as the table a reviewer reads instead of the steps.
 *
 * `steps[].files` answers "which files does step 3 touch" — the implementer's
 * question. The approver's question is the transpose: "what happens to the
 * codebase", split the way a team splits review — frontend, backend, and the
 * config someone has to set on a server. Before this, the only place a file
 * appeared was trailing off the end of a step paragraph, so #8765's approval
 * comment held its 19 files inside 10.6 KB of prose, and whether a file was
 * new or edited was not written down anywhere at all.
 *
 * `action` and `area` come from the planner rather than from the path. Only
 * the plan knows a file is about to be CREATED, and `area` is a claim about
 * what the change does — an environment variable read in a settings module is
 * config, not backend. What the path does say reliably — that a file is a test
 * or a migration — is tagged from the path, so the planner is not asked for a
 * fact the renderer can read for itself.
 */
import { codeSpan, tableCell } from './gitlabmd.js';

export const FILE_ACTIONS = ['create', 'modify', 'delete'] as const;
export const FILE_AREAS = ['frontend', 'backend', 'config'] as const;

export type FileAction = typeof FILE_ACTIONS[number];
export type FileArea = typeof FILE_AREAS[number];

export interface FileChange { path: string; action: FileAction; area: FileArea; what: string }

/** The two plan fields this file reads; the rest of the artifact is ignored. */
export interface FilesPlan { fileChanges?: unknown; steps?: unknown }

const ACTION_ICON: Record<FileAction, string> = { create: '🆕', modify: '✏️', delete: '🗑️' };
const ACTION_WORD: Record<FileAction, string> = { create: 'new', modify: 'modified', delete: 'deleted' };
const AREA_TITLE: Record<FileArea, string> = { frontend: 'Frontend', backend: 'Backend', config: 'Config' };

/** A `tests/`/`__tests__/` directory, a `*.test.js`/`*.spec.ts` module, or a Django test module. */
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_tests?|tests?)\.py$/;
const MIGRATION_PATH = /(^|\/)migrations\//;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Whatever plan.json holds, reduced to rows this file can draw. An entry with
 * no path, or an action or area outside the enums, is dropped with a warning
 * rather than guessed at — a row saying "new" about a file that exists would
 * be worse than no row. A second entry for the same path is dropped too: one
 * file, one row, whatever the steps did to it.
 */
export function fileChangesOf(plan: FilesPlan | null, warnings: string[]): FileChange[] {
  const out: FileChange[] = [];
  const seen = new Set<string>();
  for (const v of asArray(plan?.fileChanges)) {
    const c = (v ?? {}) as Record<string, unknown>;
    const path = String(c.path ?? '').replace(/\s+/g, ' ').trim();
    const action = c.action as FileAction;
    const area = c.area as FileArea;
    if (!path) { warnings.push('file change without a path dropped'); continue; }
    if (seen.has(path)) { warnings.push(`duplicate file change "${path}" dropped`); continue; }
    if (!(FILE_ACTIONS as readonly string[]).includes(action)) { warnings.push(`"${path}": unknown action "${String(c.action)}", dropped`); continue; }
    if (!(FILE_AREAS as readonly string[]).includes(area)) { warnings.push(`"${path}": unknown area "${String(c.area)}", dropped`); continue; }
    seen.add(path);
    out.push({ path, action, area, what: String(c.what ?? '').trim() });
  }
  return out;
}

/**
 * Every path the plan says it will touch — `steps[].files`, then each
 * `fileChanges[].path` — trimmed, de-duplicated, empty ones dropped.
 *
 * Deliberately not read through `fileChangesOf`. That normaliser decides what
 * the table can DRAW, and drops a row whose action or area is off the enum;
 * this list decides whether the guarded-path gate arms (`declaredFiles`) and
 * which skills and agents implement is given (`planForecast`). A row with
 * `area: 'Backend'` is a bad table row but still a file the planner said it
 * would change — read through the renderer, `apps/payroll/views.py` on such a
 * row never reached the gate. Both readers share this so they cannot disagree
 * about what the plan declares, which they did when only the gate read the
 * table and the forecast read only the steps.
 */
export function planFilePaths(plan: FilesPlan | null): string[] {
  const fromSteps = asArray(plan?.steps).flatMap((s) => asArray((s as { files?: unknown } | null)?.files));
  const fromTable = asArray(plan?.fileChanges).map((c) => (c as { path?: unknown } | null)?.path);
  const paths = [...fromSteps, ...fromTable].map((p) => String(p ?? '').trim()).filter(Boolean);
  return [...new Set(paths)];
}

/** A path as a table-safe code span: GFM splits a row on `|` before it sees any span. */
const cellCode = (s: string): string => codeSpan(s).replace(/\|/g, '\\|');

/**
 * File name first and bold, its directory underneath in small type. A column
 * of full paths is a column of `frontend/src/components/leaves/person_view/…`
 * prefixes, and the part that differs — the name — is the part pushed off the
 * end; split, the name is what the eye lands on and the path is still whole.
 */
function fileCell(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 && slash < path.length - 1 ? path.slice(slash + 1) : path;
  const dir = name === path ? '' : path.slice(0, slash + 1);
  const tags = `${TEST_PATH.test(path) ? ' 🧪' : ''}${MIGRATION_PATH.test(path) ? ' 🗄️' : ''}`;
  const head = `**${cellCode(name)}**${tags}`;
  return dir ? `${head}<br><sub>${cellCode(dir)}</sub>` : head;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface RenderedFileChanges {
  /** '' when the plan carries no usable `fileChanges`. */
  markdown: string;
  changes: FileChange[];
  warnings: string[];
}

/**
 * The count line, one table per area that has any rows — Config appears only
 * when a change needs one — and a key for whichever path tags are present.
 * No heading, so the comment and the attached plan can each title it in their
 * own register.
 *
 * A file the steps name but this table does not is reported under the tables
 * rather than silently added: the planner said nothing about whether it is
 * new or edited, and inventing either would put a claim in its mouth.
 */
export function renderFileChanges(plan: FilesPlan | null): RenderedFileChanges {
  const warnings: string[] = [];
  const changes = fileChangesOf(plan, warnings);
  if (!changes.length) return { markdown: '', changes, warnings };

  const counts = FILE_ACTIONS
    .map((a) => [a, changes.filter((c) => c.action === a).length] as const)
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${ACTION_ICON[a]} ${n} ${ACTION_WORD[a]}`);
  const parts = [`${plural(changes.length, 'file')} · ${counts.join(' · ')}`];

  for (const area of FILE_AREAS) {
    const rows = changes.filter((c) => c.area === area);
    if (!rows.length) continue;
    parts.push([
      `**${AREA_TITLE[area]}** — ${plural(rows.length, 'file')}`,
      '',
      '| | File | Change |',
      '|---|---|---|',
      ...rows.map((c) => `| ${ACTION_ICON[c.action]} | ${fileCell(c.path)} | ${tableCell(c.what) || '—'} |`),
    ].join('\n'));
  }

  const listed = new Set(changes.map((c) => c.path));
  const steps = asArray(plan?.steps).map((s) => (s ?? {}) as { files?: unknown });
  const unlisted = [...new Set(steps.flatMap((s) => asArray(s.files).map((f) => String(f).trim())))]
    .filter((f) => f && !listed.has(f));
  if (unlisted.length) {
    parts.push(`⚠️ Named in the steps but missing from these tables: ${unlisted.map(codeSpan).join(', ')}`);
  }

  const keys = [
    changes.some((c) => TEST_PATH.test(c.path)) ? '🧪 test' : '',
    changes.some((c) => MIGRATION_PATH.test(c.path)) ? '🗄️ migration' : '',
  ].filter(Boolean);
  if (keys.length) parts.push(`<sub>${keys.join(' · ')}</sub>`);

  return { markdown: parts.join('\n\n'), changes, warnings };
}

/** `renderFileChanges(plan).markdown` — for callers that only splice it in. */
export function fileChangesSection(plan: FilesPlan | null): string {
  return renderFileChanges(plan).markdown;
}
