/**
 * The test-case sheet, as pure decisions: which tab a ticket's cases go to,
 * where in the tracker its row belongs, and the exact `batchUpdate` requests
 * that put them there. Nothing here fetches. sheets.ts reads the spreadsheet,
 * hands the grids, tabs, merges and ownership marks to these functions, and
 * posts what they return, so every layout rule is tested against the real
 * sheets' shapes without a network.
 *
 * Three facts about the team's real sheet drive most of what follows:
 *
 * 1. People wrote it, over years. Tab names vary (`TestCases_Profile`,
 *    `Test_Cases_Job_Requisition`, `Team Reviews [Latest]`, `Training - Latest `
 *    with a trailing space), tracker sections are spelt unlike their tabs
 *    (`Leaves` for `TestCases_Leave`), and case columns move from block to
 *    block. So tabs and sections are matched on a folded name, headers are found
 *    by content, and nothing assumes a column letter.
 *
 * 2. Merges hide cells. A value written into a cell that sits inside someone
 *    else's merge is stored, reads back fine, and cannot be seen. So a cell under
 *    a merge is never "free", and a row that would land inside one is refused
 *    (`blocked`) instead of written.
 *
 * 3. The team writes blocks and rows for the same tickets by hand. Text cannot
 *    tell theirs from ours, so oneshot tags its own rows with developer metadata
 *    (`MARK_KEY`) in the same atomic batch that writes them. Only a marked row is
 *    "already there"; a human `Ticket #<iid>:` banner never is.
 *
 * Rows and columns are 0-based everywhere here, as the API's are. Only A1
 * strings and messages meant for people are 1-based.
 */

export interface SheetConfig {
  spreadsheetId: string; trackerTab: string; moduleTabPrefix: string;
  /** module display name → tracker column-A text, for sections spelt unlike their tab. Optional. */
  sectionAliases?: Record<string, string>;
}
export interface TabInfo { sheetId: number; title: string; index: number; hidden: boolean; rowCount: number; columnCount: number }
export interface Merge { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }
/** values.get with FORMULA render; ragged rows; '' for empty. */
export type Grid = string[][];
/** One batchUpdate request. */
export type SheetRequest = Record<string, unknown>;
export interface SheetCase {
  id: string; scenario: string; precondition: string; steps: string[]; expected: string;
  automatable: 'yes' | 'partly' | 'no'; reason: string;
}
export type CaseField = 'id' | 'scenario' | 'precondition' | 'steps' | 'expected' | 'automatable' | 'reason';
/** A header row found by content: its 0-based row and the 0-based column of each header, keyed by the header as asked for. */
export interface HeaderRow { row: number; cols: Record<string, number> }

/** The real sheet's legend and header colours. */
export const COLORS = {
  header: '#44546a', headerText: '#ffffff', done: '#b6d7a8', newCases: '#ff9900',
  cannot: '#ff0000', cannotText: '#ffffff', yes: '#b6d7a8', partly: '#ffe599', no: '#f4cccc',
  white: '#ffffff', black: '#000000',
} as const;
export const CASE_HEADERS = ['ID', 'Test Scenario', 'Pre Condition', 'Steps', 'Expected Result', 'Automatable', 'Reason'] as const;
export const TRACKER_HEADERS = ['Modules', 'Ticket Updates', 'Test Case Status', 'Automation Status', 'Test Case Link'] as const;
/**
 * Byte-exact: the real tracker's C/D cells carry STRICT ONE_OF_LIST validation
 * (Pending, In Progress, On Hold, Done, Admin side, Automation limitation, Not
 * started), so a one-character drift is rejected by the API and the whole batch
 * with it.
 */
export const STATUS = { done: 'Done', notStarted: 'Not started', limitation: 'Automation limitation' } as const;
/** The developer-metadata key on every row oneshot wrote. */
export const MARK_KEY = 'oneshot-automation';

/** CASE_HEADERS order, as fields. */
const CASE_FIELDS: readonly CaseField[] = ['id', 'scenario', 'precondition', 'steps', 'expected', 'automatable', 'reason'];
const [H_MODULE, H_TICKET, H_STATUS, H_AUTOMATION, H_LINK] = TRACKER_HEADERS;

/**
 * Google refuses a cell over 50,000 characters, and the refusal fails the whole
 * batch on every retry. A model-written reason that long is a bug, but it must
 * not wedge the ticket, so the one cell is cut instead.
 */
const MAX_CELL = 49_000;

// ------------------------------------------------------------------ small helpers

export function rgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace(/^#/, '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { red: n(0), green: n(2), blue: n(4) };
}

/** 0 → A, 25 → Z, 26 → AA. */
export function a1Col(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1Range(m: Merge): string {
  return `${a1Col(m.startColumnIndex)}${m.startRowIndex + 1}:${a1Col(m.endColumnIndex - 1)}${m.endRowIndex}`;
}

function cell(grid: Grid, r: number, c: number): string {
  return c < 0 ? '' : grid[r]?.[c] ?? '';
}

function cellText(s: string): string {
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}

/** What read-back compares: the API may hand a string back with a leading `'`, and CRLF as LF. */
function comparable(s: string | undefined): string {
  return (s ?? '').replace(/\r\n/g, '\n').replace(/^'/, '').trim();
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function covers(m: Merge, row: number, col: number): boolean {
  return m.startRowIndex <= row && row < m.endRowIndex && m.startColumnIndex <= col && col < m.endColumnIndex;
}

/** The merge that starts at `row` and covers column `colA`: a tracker section's own A-merge. */
function sectionMerge(merges: Merge[], row: number, colA: number): Merge | null {
  return merges.find((m) => m.startRowIndex === row && m.startColumnIndex <= colA && colA < m.endColumnIndex) ?? null;
}

function gridRange(sheetId: number, r0: number, r1: number, c0: number, c1: number): Record<string, number> {
  return { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 };
}

function headerCol(header: HeaderRow, name: string): number {
  return header.cols[name] ?? -1;
}

// ------------------------------------------------------------------ formats

const SOLID = { style: 'SOLID', colorStyle: { rgbColor: rgb(COLORS.black) } };
const BORDERS = { top: SOLID, bottom: SOLID, left: SOLID, right: SOLID };

type Format = Record<string, unknown>;

function format(o: {
  bg?: string; fg?: string; bold?: boolean; size?: number;
  h?: 'LEFT' | 'CENTER'; v?: 'TOP' | 'MIDDLE'; borders?: boolean;
}): Format {
  return {
    ...(o.bg ? { backgroundColorStyle: { rgbColor: rgb(o.bg) } } : {}),
    textFormat: {
      bold: o.bold ?? false,
      fontFamily: 'Arial',
      ...(o.size ? { fontSize: o.size } : {}),
      foregroundColorStyle: { rgbColor: rgb(o.fg ?? COLORS.black) },
    },
    ...(o.h ? { horizontalAlignment: o.h } : {}),
    ...(o.v ? { verticalAlignment: o.v } : {}),
    wrapStrategy: 'WRAP',
    ...(o.borders ? { borders: BORDERS } : {}),
  };
}

const HEADER = format({ bg: COLORS.header, fg: COLORS.headerText, bold: true, size: 12, h: 'CENTER', v: 'MIDDLE', borders: true });
const BANNER = format({ bg: COLORS.newCases, bold: true, size: 11, h: 'CENTER', v: 'MIDDLE' });
const CASE = (bg: string) => format({ bg, size: 10, h: 'LEFT', v: 'TOP', borders: true });
const DATA = (bg: string = COLORS.white, fg: string = COLORS.black, h: 'LEFT' | 'CENTER' = 'LEFT') =>
  format({ bg, fg, size: 12, h, v: 'MIDDLE', borders: true });
const LEGEND_TITLE = format({ bold: true, size: 11, v: 'MIDDLE' });
const LEGEND_TEXT = format({ size: 10, v: 'MIDDLE' });

/**
 * The mask every value write uses. Listing the format fields explicitly means a
 * row that inherited a neighbour's red D cell or bold text gets ours instead.
 */
const CELL_FIELDS = 'userEnteredValue,userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,borders)';
const FORMAT_FIELDS = 'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,borders)';

interface CellData { userEnteredValue?: { stringValue: string } | { formulaValue: string }; userEnteredFormat?: Format }

/** stringValue, never formulaValue, for model text: a case that starts with `=` stays text. */
function textCell(s: string, f?: Format): CellData {
  return { userEnteredValue: { stringValue: cellText(s) }, ...(f ? { userEnteredFormat: f } : {}) };
}

function formulaCell(s: string, f: Format): CellData {
  return { userEnteredValue: { formulaValue: s }, userEnteredFormat: f };
}

function updateCells(sheetId: number, row: number, col: number, rows: CellData[][], fields = CELL_FIELDS): SheetRequest {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: col },
      rows: rows.map((values) => ({ values })),
      fields,
    },
  };
}

/**
 * `n` new rows at `at`: inserted while inside the grid, appended past its end.
 * insertDimension at or after `rowCount` is refused (there is no row there to
 * insert before), so whatever does not fit is appended instead. Either way
 * nothing already below `at` is overwritten.
 */
function makeRows(sheetId: number, rowCount: number, at: number, n: number, inheritFromBefore: boolean): SheetRequest[] {
  const fits = Math.min(n, Math.max(0, rowCount - at));
  const out: SheetRequest[] = [];
  if (fits > 0) {
    out.push({ insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + fits }, inheritFromBefore } });
  }
  if (n - fits > 0) out.push({ appendDimension: { sheetId, dimension: 'ROWS', length: n - fits } });
  return out;
}

/** Rows appended so that a grid of `rowCount` rows reaches `needed` rows. */
export function ensureRows(sheetId: number, rowCount: number, needed: number): SheetRequest[] {
  return needed > rowCount ? [{ appendDimension: { sheetId, dimension: 'ROWS', length: needed - rowCount } }] : [];
}

/** Columns appended so that column `lastCol` exists: a mapped block can reach past a narrow tab's last column. */
export function ensureColumns(sheetId: number, columnCount: number, lastCol: number): SheetRequest[] {
  return lastCol >= columnCount ? [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: lastCol + 1 - columnCount } }] : [];
}

function widths(sheetId: number, px: number[]): SheetRequest[] {
  return px.map((pixelSize, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }));
}

// ------------------------------------------------------------------ names

/** trim, lower, strip non-alphanumerics: `Test Case Link ` and `testcaselink` are the same header. */
export function normHeader(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tab title → the module name shown to the model and matched on:
 * 1. strip a leading test-cases prefix (`TestCases_`, `Test_Cases_`, `TestCases -`,
 *    `TestCases _ `, `Testcases `);
 * 2. drop `[...]` and `(...)` groups;
 * 3. underscores read as spaces (`Job_Requisition` → `Job Requisition`), so the
 *    model is shown a name, not a tab slug;
 * 4. drop a trailing ` - Latest`, ` - New` or ` - Updated`, only after a ` - `
 *    separator, so `New Joiners` keeps "New";
 * 5. collapse whitespace and trim.
 */
export function moduleDisplayName(title: string): string {
  return title
    .replace(/^\s*test[\s_-]*cases?[\s_-]*/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+-\s+(?:latest|new|updated)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The matching key: lowercase alphanumeric words, each plural-folded (`ies` →
 * `y`; a trailing `s` dropped unless the word ends in `ss`), joined with
 * nothing. So `Leaves`/`Leave`, `Competencies`/`Competency` and
 * `Team Reviews`/`TeamReview` meet. '' is never a match: it would equal every
 * blank column-A cell.
 */
export function normaliseModule(name: string): string {
  const words = String(name ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words
    .map((w) => (w.endsWith('ies') && w.length > 3 ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join('');
}

export function trackerTitle(pattern: string, year: number): string {
  return pattern.replaceAll('{year}', String(year));
}

/** The tracker pattern for ANY 4-digit year (brackets and other regex characters taken literally), compared trimmed. */
export function isTrackerTitle(title: string, pattern: string): boolean {
  const escaped = pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replaceAll('\\{year\\}', '\\d{4}')}$`, 'i');
  return re.test(title.trim());
}

/** Prefix + module, whitespace collapsed, trimmed, cut to 100 characters (Sheets' tab-title limit). Throws on an empty result. */
export function moduleTabTitle(prefix: string, module: string): string {
  const clean = String(module ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('a module tab needs a module name');
  return `${prefix}${clean}`.slice(0, 100).trim();
}

/** Tabs that can hold a module's cases: visible, not outdated, not a tracker, with a name that folds to something. */
function candidateTabs(tabs: TabInfo[], cfg: SheetConfig): TabInfo[] {
  return tabs.filter((t) =>
    !t.hidden
    && !/outdated/i.test(t.title)
    && !isTrackerTitle(t.title, cfg.trackerTab)
    && !/^test\s*cases?\s*updates/i.test(t.title.trim())
    && normaliseModule(moduleDisplayName(t.title)) !== '');
}

/** Preference among tabs for one module: a `latest` title, then the exact title oneshot would create, then the leftmost. */
function preferred(cands: TabInfo[], module: string, cfg: SheetConfig): TabInfo | null {
  let exact = '';
  try { exact = moduleTabTitle(cfg.moduleTabPrefix, module); } catch { /* no exact title for an empty module */ }
  const rank = (t: TabInfo) => (/latest/i.test(t.title) ? 0 : t.title.trim() === exact ? 1 : 2);
  return [...cands].sort((a, b) => rank(a) - rank(b) || a.index - b.index)[0] ?? null;
}

/**
 * The module tabs to show the model, one per module (the tab findModuleTab would
 * pick), leftmost first. `tab` is the EXACT title, trailing spaces kept, because
 * ranges must use it.
 */
export function moduleTabs(tabs: TabInfo[], cfg: SheetConfig): Array<{ tab: string; module: string }> {
  const groups = new Map<string, TabInfo[]>();
  for (const t of candidateTabs(tabs, cfg)) {
    const key = normaliseModule(moduleDisplayName(t.title));
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const picked: TabInfo[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const best = first ? preferred(group, moduleDisplayName(first.title), cfg) : null;
    if (best) picked.push(best);
  }
  return picked.sort((a, b) => a.index - b.index).map((t) => ({ tab: t.title, module: moduleDisplayName(t.title) }));
}

export function findModuleTab(tabs: TabInfo[], module: string, cfg: SheetConfig): TabInfo | null {
  const key = normaliseModule(module);
  if (!key) return null;
  const cands = candidateTabs(tabs, cfg).filter((t) => normaliseModule(moduleDisplayName(t.title)) === key);
  return preferred(cands, module, cfg);
}

/**
 * A sheetId for a tab we are about to create. We choose it (rather than letting
 * the API) so later requests in the same atomic batch can address the new tab.
 * Deterministic for a seed, so a retried batch plans the same id; positive and
 * below 2^31, as the API requires.
 */
export function newSheetId(existing: number[], seed: number): number {
  const taken = new Set(existing);
  let id = (Math.abs(Math.trunc(seed)) % 2_000_000_000) + 1;
  while (taken.has(id)) id = (id % 2_000_000_000) + 1;
  return id;
}

// ------------------------------------------------------------------ reading a grid

/** The first row within `scanRows` that holds every header (by normHeader), with each header's first column. */
export function findHeaderRow(grid: Grid, headers: readonly string[], scanRows = 10): HeaderRow | null {
  for (let r = 0; r < Math.min(scanRows, grid.length); r++) {
    const row = (grid[r] ?? []).map(normHeader);
    const cols: Record<string, number> = {};
    for (const h of headers) {
      const c = row.indexOf(normHeader(h));
      if (c < 0) break;
      cols[h] = c;
    }
    if (Object.keys(cols).length === headers.length) return { row: r, cols };
  }
  return null;
}

export interface CaseColumns {
  /** 0-based column per field. */
  col: Record<CaseField, number>;
  /** max of col. */
  lastCol: number;
  /** The header row the mapping was read from; null = none, default A..G. */
  fromRow: number | null;
  /** Write a per-block sub-header row (false only when row 1 of the tab maps all seven). */
  subHeader: boolean;
}

/**
 * Where each case field goes on a module tab.
 *
 * The real sheet's convention is a per-block sub-header (`Test Scenario | Pre
 * Condition | Steps` in C–E on one tab, D–F on another) and no real tab's row 1
 * describes the cases, so the mapping follows the LAST row naming at least three
 * of our headers: that is how the team writes cases today. Matched fields take
 * their columns; `ID` takes the column just left of `Test Scenario` when that is
 * free; every other field goes right of the row's last used column, in header
 * order. With no such row the block is A..G with its own sub-header.
 */
export function mapCaseColumns(grid: Grid): CaseColumns {
  const keys = CASE_HEADERS.map(normHeader);
  let from: number | null = null;
  grid.forEach((row, r) => {
    const found = new Set(row.map(normHeader).filter((k) => keys.includes(k)));
    if (found.size >= 3) from = r;
  });
  if (from === null) {
    const col = Object.fromEntries(CASE_FIELDS.map((f, i) => [f, i])) as Record<CaseField, number>;
    return { col, lastCol: CASE_FIELDS.length - 1, fromRow: null, subHeader: true };
  }
  const row = grid[from] ?? [];
  const col: Partial<Record<CaseField, number>> = {};
  const taken = new Set<number>();
  row.forEach((text, c) => {
    const i = keys.indexOf(normHeader(text));
    const f = CASE_FIELDS[i];
    if (f && col[f] === undefined) { col[f] = c; taken.add(c); }
  });
  const matched = Object.keys(col).length;
  if (col.id === undefined && col.scenario !== undefined && col.scenario > 0 && !taken.has(col.scenario - 1)) {
    col.id = col.scenario - 1;
    taken.add(col.id);
  }
  let used = -1;
  row.forEach((text, c) => { if (String(text).trim()) used = c; });
  let next = Math.max(used, ...taken) + 1;
  for (const f of CASE_FIELDS) {
    if (col[f] !== undefined) continue;
    while (taken.has(next)) next++;
    col[f] = next;
    taken.add(next);
    next++;
  }
  const full = col as Record<CaseField, number>;
  return {
    col: full,
    lastCol: Math.max(...CASE_FIELDS.map((f) => full[f])),
    fromRow: from,
    subHeader: !(from === 0 && matched === CASE_FIELDS.length),
  };
}

/** Last row with any non-blank cell; -1 when the grid is empty. */
export function lastUsedRow(grid: Grid): number {
  for (let r = grid.length - 1; r >= 0; r--) {
    if ((grid[r] ?? []).some((c) => String(c).trim() !== '')) return r;
  }
  return -1;
}

/** The row whose column-A cell says `Legends` (trimmed, any case; `Legend` too). */
export function findLegendRow(grid: Grid, colA: number): number | null {
  for (let r = 0; r < grid.length; r++) {
    if (/^legends?$/i.test(cell(grid, r, colA).trim())) return r;
  }
  return null;
}

/** Last row of the legend block: the last consecutive row after the `Legends` row with text in A or B. */
export function legendEnd(grid: Grid, legendRow: number, colA: number): number {
  let end = legendRow;
  for (let r = legendRow + 1; r < grid.length; r++) {
    if (!cell(grid, r, colA).trim() && !cell(grid, r, colA + 1).trim()) break;
    end = r;
  }
  return end;
}

export function legendHasLimitation(grid: Grid, legendRow: number, end: number): boolean {
  for (let r = legendRow; r <= end; r++) {
    if ((grid[r] ?? []).some((c) => /automation limitation/i.test(c))) return true;
  }
  return false;
}

// ------------------------------------------------------------------ ownership marks

/** Oneshot's ownership marks, read back from developerMetadata:search. Rows are 0-based and current. */
export interface OwnMark { kind: 'block' | 'block-end' | 'tracker'; sheetId: number; row: number }

export function ownMarkValues(iid: number): string[] {
  return [`block:${iid}`, `block-end:${iid}`, `tracker:${iid}`];
}

/**
 * The marks for `iid` in a developerMetadata:search response. The API is proto
 * JSON, which OMITS zero values: a mark on the first tab (sheetId 0) or the
 * first row carries no `sheetId`/`startIndex` at all, so both default to 0.
 */
export function parseOwnMarks(searchResponse: unknown, iid: number): OwnMark[] {
  const wanted = new Set(ownMarkValues(iid));
  const list = (searchResponse as { matchedDeveloperMetadata?: unknown } | null)?.matchedDeveloperMetadata;
  if (!Array.isArray(list)) return [];
  const out: OwnMark[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const md = (item as { developerMetadata?: Record<string, unknown> } | null)?.developerMetadata;
    if (!md || md.metadataKey !== MARK_KEY || typeof md.metadataValue !== 'string' || !wanted.has(md.metadataValue)) continue;
    const range = (md.location as { dimensionRange?: Record<string, unknown> } | undefined)?.dimensionRange;
    if (!range || (range.dimension !== undefined && range.dimension !== 'ROWS')) continue;
    const mark: OwnMark = {
      kind: md.metadataValue.slice(0, md.metadataValue.lastIndexOf(':')) as OwnMark['kind'],
      sheetId: Number(range.sheetId ?? 0),
      row: Number(range.startIndex ?? 0),
    };
    const key = `${mark.kind}/${mark.sheetId}/${mark.row}`;
    if (!seen.has(key)) { seen.add(key); out.push(mark); }
  }
  return out.sort((a, b) => a.sheetId - b.sheetId || a.row - b.row);
}

/** createDeveloperMetadata on ONE row (the API rejects multi-row dimension ranges), visibility DOCUMENT. */
export function ownMarkRequest(sheetId: number, row: number, kind: OwnMark['kind'], iid: number): SheetRequest {
  return {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: MARK_KEY,
        metadataValue: `${kind}:${iid}`,
        visibility: 'DOCUMENT',
        location: { dimensionRange: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 } },
      },
    },
  };
}

// ------------------------------------------------------------------ tracker placement

export type TrackerPlacement =
  | { kind: 'fill'; row: number; sectionRow: number }                    // empty, unmerged row inside the section
  | { kind: 'insert'; row: number; sectionRow: number }                  // insert at row, re-merge A[sectionRow..row]
  | { kind: 'new-section'; row: number }                                 // insert at row with A = module
  | { kind: 'blocked'; why: string };                                    // → SheetsFail 'layout'

function aliasFor(module: string, aliases?: Record<string, string>): string | null {
  if (!aliases) return null;
  const direct = aliases[module];
  if (direct) return direct;
  const key = normaliseModule(module);
  if (!key) return null;
  const hit = Object.entries(aliases).find(([k]) => normaliseModule(k) === key);
  return hit ? hit[1] : null;
}

/**
 * The tracker section for a module, first hit wins:
 * 1. a row below the header whose column A folds to the same name;
 * 2. the configured alias for the module (trimmed, any case);
 * 3. the section holding a row whose Test Case Link points at the module tab's
 *    gid: the team's own rows link their tab, which is how `Leaves` is found from
 *    `TestCases_Leave`.
 * The real tracker names 10 of its 26 sections unlike any tab, so all three are needed.
 */
export function findSection(
  grid: Grid, header: HeaderRow, module: string,
  o: { moduleGid: number | null; aliases?: Record<string, string> },
): { row: number; by: 'name' | 'alias' | 'gid' } | null {
  const colA = headerCol(header, H_MODULE);
  const key = normaliseModule(module);
  if (key) {
    for (let r = header.row + 1; r < grid.length; r++) {
      if (normaliseModule(cell(grid, r, colA)) === key) return { row: r, by: 'name' };
    }
  }
  const alias = aliasFor(module, o.aliases)?.trim().toLowerCase();
  if (alias) {
    for (let r = header.row + 1; r < grid.length; r++) {
      if (cell(grid, r, colA).trim().toLowerCase() === alias) return { row: r, by: 'alias' };
    }
  }
  if (o.moduleGid !== null) {
    const linkCol = headerCol(header, H_LINK);
    const re = new RegExp(`gid=${o.moduleGid}(?!\\d)`);
    for (let r = header.row + 1; r < grid.length; r++) {
      if (!re.test(cell(grid, r, linkCol))) continue;
      for (let s = r; s > header.row; s--) {
        if (cell(grid, s, colA).trim()) return { row: s, by: 'gid' };
      }
    }
  }
  return null;
}

/**
 * Where this ticket's tracker row goes. `merges` must already be filtered to the
 * tracker's sheetId. `tab` only names the tab in a `blocked` reason.
 *
 * A row is free when its B..E cells are empty AND none of them sits inside a
 * merge other than the section's own column-A merge: the real tracker has B11:B15
 * merged across two sections, and a value under it is invisible. When there is
 * no free row the section grows by one (insert after its end, A-merge extended);
 * with no section, a new one goes above the legend, or after the last used row.
 * A new row that would land strictly inside a merge is swallowed by it, so that
 * is `blocked`, never written.
 */
export function planTrackerPlacement(
  grid: Grid, header: HeaderRow, module: string, merges: Merge[],
  o: { moduleGid: number | null; aliases?: Record<string, string>; tab?: string },
): TrackerPlacement {
  const colA = headerCol(header, H_MODULE);
  const dataCols = [H_TICKET, H_STATUS, H_AUTOMATION, H_LINK].map((h) => headerCol(header, h));
  const allCols = [colA, ...dataCols];
  const minC = Math.min(...allCols);
  const maxC = Math.max(...allCols);
  const last = lastUsedRow(grid);
  const swallowing = (k: number, except: Merge | null) => merges.find((m) =>
    m !== except && m.startRowIndex < k && k < m.endRowIndex && m.startColumnIndex <= maxC && m.endColumnIndex > minC);
  const blocked = (k: number, m: Merge): TrackerPlacement => ({
    kind: 'blocked',
    why: `row ${k + 1}${o.tab ? ` of '${o.tab}'` : ''} falls inside the merged range ${a1Range(m)}; unmerge it so a new row can be seen`,
  });

  const section = findSection(grid, header, module, o);
  if (!section) {
    const legend = findLegendRow(grid, colA);
    let k = Math.max(legend ?? last + 1, header.row + 1);
    if (legend === null) {
      // The last section's A-merge often runs over empty reserve rows past the
      // last value. A new section starts after that merge, not inside it.
      for (;;) {
        const m = merges.find((x) => covers(x, k, colA) && x.startRowIndex < k);
        if (!m) break;
        k = m.endRowIndex;
      }
    }
    const m = swallowing(k, null);
    return m ? blocked(k, m) : { kind: 'new-section', row: k };
  }

  const start = section.row;
  const own = sectionMerge(merges, start, colA);
  let end: number;
  if (own) {
    end = own.endRowIndex - 1;
  } else {
    let next = -1;
    for (let r = start + 1; r < grid.length; r++) {
      if (cell(grid, r, colA).trim()) { next = r; break; }
    }
    end = next >= 0 ? Math.min(next - 1, last) : last;
  }
  end = Math.max(end, start);
  for (let r = start; r <= end; r++) {
    const empty = dataCols.every((c) => !cell(grid, r, c).trim());
    const hidden = dataCols.some((c) => merges.some((m) => m !== own && covers(m, r, c)));
    if (empty && !hidden) return { kind: 'fill', row: r, sectionRow: start };
  }
  const k = end + 1;
  const m = swallowing(k, own);
  return m ? blocked(k, m) : { kind: 'insert', row: k, sectionRow: start };
}

// ------------------------------------------------------------------ request builders

/** rows 0-based; a1 like 'A730:H737'. */
export interface BlockPlan { requests: SheetRequest[]; bannerRow: number; firstCaseRow: number; lastRow: number; lastCol: number; a1: string }

/** A module tab oneshot creates: orange tab colour, frozen header A1:G1 in the header style, readable widths. */
export function newModuleTabRequests(sheetId: number, title: string): SheetRequest[] {
  return [
    {
      addSheet: {
        properties: {
          sheetId, title,
          tabColorStyle: { rgbColor: rgb(COLORS.newCases) },
          gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 },
        },
      },
    },
    updateCells(sheetId, 0, 0, [CASE_HEADERS.map((h) => textCell(h, HEADER))]),
    ...widths(sheetId, [70, 320, 260, 420, 320, 110, 280]),
  ];
}

/**
 * A year's tracker oneshot creates: header A1:E1, frozen. It has none of the
 * team's sections or C/D validation; a person copies the format once a year.
 */
export function newTrackerTabRequests(sheetId: number, title: string): SheetRequest[] {
  return [
    { addSheet: { properties: { sheetId, title, gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } } } },
    updateCells(sheetId, 0, 0, [TRACKER_HEADERS.map((h) => textCell(h, HEADER))]),
    ...widths(sheetId, [200, 460, 145, 145, 420]),
  ];
}

/** Paired emphasis outside code: `**x**`, `__x__`, `*x*`, `_x_`. A lone `*` and a snake_case name are left alone. */
function unemphasise(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1');
}

/**
 * Case text as a plain cell shows it. The cases note renders `**Save**` as
 * bold and `` `selectFile` `` as code; a sheet cell or a CSV opened in a
 * spreadsheet shows the asterisks and backticks as they are. So emphasis
 * markers come off, and a code span keeps its text without its backticks —
 * untouched inside, so `__init__.py` in backticks stays `__init__.py`.
 */
export function plainText(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    out += unemphasise(s.slice(last, m.index)) + (m[2] ?? '');
    last = m.index + m[0].length;
  }
  return out + unemphasise(s.slice(last));
}

function stepsText(steps: string[]): string {
  // A model that numbered its own steps would otherwise read "1. 1. Open …".
  return steps.map((s, i) => `${i + 1}. ${plainText(s.replace(/^\s*\d+\s*[.)]\s*/, '').trim())}`).join('\n');
}

function caseValue(c: SheetCase, f: CaseField): string {
  switch (f) {
    case 'id': return c.id;
    case 'scenario': return plainText(c.scenario);
    case 'precondition': return c.precondition.trim() ? plainText(c.precondition) : '—';
    case 'steps': return stepsText(c.steps);
    case 'expected': return plainText(c.expected);
    case 'automatable': return c.automatable;
    case 'reason': return plainText(c.reason);
  }
}

function bannerText(iid: number, title: string): string {
  return `Ticket #${iid}: ${title.replace(/\s+/g, ' ').trim()}`;
}

/**
 * One ticket's block at the end of a module tab: [spacer], banner, [sub-header],
 * one row per case. Rows are made first (insertDimension inside the grid,
 * appendDimension at or past its end), then the values, the banner merge, and
 * finally the ownership marks on the banner and last rows, all in the one batch.
 */
export function moduleBlockRequests(o: {
  sheetId: number; rowCount: number; grid: Grid; iid: number; title: string; cases: SheetCase[]; columns: CaseColumns;
}): BlockPlan {
  const { sheetId, columns } = o;
  const last = lastUsedRow(o.grid);
  const spacer = last > 0 ? 1 : 0;
  const insertAt = last + 1;
  const n = spacer + 1 + (columns.subHeader ? 1 : 0) + o.cases.length;
  const bannerRow = insertAt + spacer;
  const firstCaseRow = bannerRow + 1 + (columns.subHeader ? 1 : 0);
  // With no cases (validation forbids it, but never write a mark above its banner) the block ends at its header rows.
  const lastRow = o.cases.length ? firstCaseRow + o.cases.length - 1 : firstCaseRow - 1;
  const lastCol = columns.lastCol;
  const firstCol = Math.min(...CASE_FIELDS.map((f) => columns.col[f]));
  const fieldAt = new Map(CASE_FIELDS.map((f) => [columns.col[f], f] as const));

  const requests: SheetRequest[] = [...makeRows(sheetId, o.rowCount, insertAt, n, false)];
  requests.push(updateCells(sheetId, bannerRow, 0, [[textCell(bannerText(o.iid, o.title), BANNER)]]));
  if (lastCol > 0) {
    requests.push({ mergeCells: { range: gridRange(sheetId, bannerRow, bannerRow + 1, 0, lastCol + 1), mergeType: 'MERGE_ALL' } });
  }
  const span = (make: (f: CaseField) => CellData): CellData[] => {
    const out: CellData[] = [];
    for (let c = firstCol; c <= lastCol; c++) {
      const f = fieldAt.get(c);
      out.push(f ? make(f) : {});
    }
    return out;
  };
  const body: CellData[][] = [];
  if (columns.subHeader) body.push(span((f) => textCell(CASE_HEADERS[CASE_FIELDS.indexOf(f)] ?? f, HEADER)));
  for (const c of o.cases) {
    body.push(span((f) => textCell(caseValue(c, f), CASE(f === 'automatable' ? COLORS[c.automatable] : COLORS.white))));
  }
  if (body.length) requests.push(updateCells(sheetId, bannerRow + 1, firstCol, body));
  requests.push(ownMarkRequest(sheetId, bannerRow, 'block', o.iid));
  requests.push(ownMarkRequest(sheetId, lastRow, 'block-end', o.iid));
  return { requests, bannerRow, firstCaseRow, lastRow, lastCol, a1: `A${bannerRow + 1}:${a1Col(lastCol)}${lastRow + 1}` };
}

/**
 * The ticket's tracker row: rows made (insert or new section), the section's
 * A-merge extended when it grew, B..E written in the data style, and the
 * `tracker` mark last. Returns the final 0-based row.
 */
export function trackerRowRequests(o: {
  sheetId: number; rowCount: number; grid: Grid; header: HeaderRow; placement: TrackerPlacement;
  merges: Merge[]; module: string; iid: number; title: string; issueUrl: string;
  status: 'Not started' | 'Automation limitation'; link: { url: string; text: string };
}): { requests: SheetRequest[]; row: number } {
  const { sheetId, header, placement } = o;
  if (placement.kind === 'blocked') throw new Error(`trackerRowRequests: ${placement.why}`);
  const colA = headerCol(header, H_MODULE);
  const row = placement.row;
  const requests: SheetRequest[] = [];
  if (placement.kind === 'insert') {
    // inheritFromBefore copies the section's validation and look from the row above.
    requests.push(...makeRows(sheetId, o.rowCount, row, 1, true));
    const own = sectionMerge(o.merges, placement.sectionRow, colA);
    if (own) requests.push({ unmergeCells: { range: gridRange(sheetId, own.startRowIndex, own.endRowIndex, own.startColumnIndex, own.endColumnIndex) } });
    const [c0, c1] = own ? [own.startColumnIndex, own.endColumnIndex] : [colA, colA + 1];
    requests.push({ mergeCells: { range: gridRange(sheetId, placement.sectionRow, row + 1, c0, c1), mergeType: 'MERGE_ALL' } });
  } else if (placement.kind === 'new-section') {
    requests.push(...makeRows(sheetId, o.rowCount, row, 1, false));
    requests.push(updateCells(sheetId, row, colA, [[textCell(o.module.replace(/\s+/g, ' ').trim(), DATA(COLORS.white, COLORS.black, 'CENTER'))]]));
  } else if (!o.merges.some((m) => covers(m, row, colA))) {
    // A filled row keeps whatever column A says (the section name on its first row); only its look is ours.
    requests.push(updateCells(sheetId, row, colA, [[{ userEnteredFormat: DATA(COLORS.white, COLORS.black, 'CENTER') }]], FORMAT_FIELDS));
  }
  const limitation = o.status === STATUS.limitation;
  const cells: Array<[number, CellData]> = [
    [headerCol(header, H_TICKET), formulaCell(hyperlinkFormula(o.issueUrl, `#${o.iid} ${o.title}`), DATA())],
    [headerCol(header, H_STATUS), textCell(STATUS.done, DATA(COLORS.done))],
    // Set explicitly both ways: an inherited row may carry the red of the row above.
    [headerCol(header, H_AUTOMATION), textCell(o.status, limitation ? DATA(COLORS.cannot, COLORS.cannotText) : DATA(COLORS.white, COLORS.black))],
    [headerCol(header, H_LINK), formulaCell(hyperlinkFormula(o.link.url, o.link.text), DATA())],
  ];
  for (const [c, data] of cells) requests.push(updateCells(sheetId, row, c, [[data]]));
  requests.push(ownMarkRequest(sheetId, row, 'tracker', o.iid));
  return { requests, row };
}

const LEGEND_LINES: ReadonlyArray<readonly [string, string]> = [
  [COLORS.done, 'Green cells means Done'],
  [COLORS.newCases, 'Orange tabs or cells means new changes or TC added'],
  [COLORS.cannot, 'Red in Automation Status means the cases cannot be automated (Automation limitation)'],
];

/** The full colour key at `row`: `Legends` in bold, then a swatch in A and its meaning in B, three lines. */
export function legendRequests(sheetId: number, row: number, colA: number): SheetRequest[] {
  return [
    updateCells(sheetId, row, colA, [[textCell('Legends', LEGEND_TITLE)]]),
    updateCells(sheetId, row + 1, colA, LEGEND_LINES.map(([bg, text]) => [
      { userEnteredFormat: format({ bg, borders: true }) },
      textCell(text, LEGEND_TEXT),
    ])),
  ];
}

/**
 * One line inserted at `row` into an existing legend that has no Automation
 * limitation entry (the real sheet's red means "Failures"). It inherits the
 * look of the legend line above; only the swatch colour and the text are set.
 * `rowCount` makes a line past the grid's end an append.
 */
export function legendLimitationLine(sheetId: number, row: number, colA: number, rowCount = Number.MAX_SAFE_INTEGER): SheetRequest[] {
  return [
    ...makeRows(sheetId, rowCount, row, 1, true),
    updateCells(sheetId, row, colA, [[{ userEnteredFormat: { backgroundColorStyle: { rgbColor: rgb(COLORS.cannot) } } }]], 'userEnteredFormat.backgroundColorStyle'),
    updateCells(sheetId, row, colA + 1, [[textCell('Red in Automation Status means Automation limitation (cannot be automated)')]], 'userEnteredValue'),
  ];
}

/**
 * The legend work for a tracker batch, decided from the grid as read (before
 * this batch's row went in):
 * - no `Legends` row → the full legend two rows under the last used row;
 * - a legend without an Automation limitation line → that one line after it;
 * - otherwise nothing: an existing legend is the team's.
 * `placedRow`/`inserted` say where this batch adds its row, which shifts
 * everything at or below it by one.
 */
export function planLegend(o: {
  sheetId: number; grid: Grid; colA: number; rowCount: number; placedRow: number; inserted: boolean;
}): { requests: SheetRequest[]; added: 'full' | 'line' | null } {
  const shift = (r: number) => (o.inserted && o.placedRow <= r ? r + 1 : r);
  const rowCount = o.rowCount + (o.inserted ? 1 : 0);
  const legendRow = findLegendRow(o.grid, o.colA);
  if (legendRow === null) {
    const last = Math.max(shift(lastUsedRow(o.grid)), o.placedRow);
    const at = last + 2;
    return {
      requests: [...ensureRows(o.sheetId, rowCount, at + 1 + LEGEND_LINES.length), ...legendRequests(o.sheetId, at, o.colA)],
      added: 'full',
    };
  }
  const end = legendEnd(o.grid, legendRow, o.colA);
  if (legendHasLimitation(o.grid, legendRow, end)) return { requests: [], added: null };
  return { requests: legendLimitationLine(o.sheetId, shift(end) + 1, o.colA, rowCount), added: 'line' };
}

// ------------------------------------------------------------------ values and links

/** Any case a person could automate at least in part means the automation work has not started; none at all is a limitation. */
export function automationStatus(cases: SheetCase[]): 'Not started' | 'Automation limitation' {
  return cases.some((c) => c.automatable === 'yes' || c.automatable === 'partly') ? STATUS.notStarted : STATUS.limitation;
}

/** `=HYPERLINK("u","t")` with `"` doubled (real ticket titles carry quotes) and line breaks flattened. */
export function hyperlinkFormula(url: string, text: string): string {
  const q = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
  return `=HYPERLINK("${q(url)}","${q(cellText(text))}")`;
}

export function deepLink(spreadsheetId: string, gid: number, a1: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}&range=${a1}`;
}

// ------------------------------------------------------------------ read-back

/**
 * A freshly written block, read back from its A1 range (row 0 = banner): the
 * banner names the ticket and every case id and scenario sits in its mapped
 * column, in order. null = ok.
 */
export function verifyBlock(read: Grid, cases: SheetCase[], iid: number, columns: CaseColumns): string | null {
  const banner = read[0]?.[0] ?? '';
  if (!banner.includes(`Ticket #${iid}:`)) return `the banner row does not say 'Ticket #${iid}:' (it says '${clip(banner)}')`;
  const offset = 1 + (columns.subHeader ? 1 : 0);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c) continue;
    const row = read[offset + i] ?? [];
    const id = comparable(row[columns.col.id]);
    if (id !== comparable(c.id)) return `case row ${i + 1} should be ${c.id}, but its ID cell says '${clip(id)}'`;
    const scenario = comparable(row[columns.col.scenario]);
    if (scenario !== comparable(cellText(caseValue(c, 'scenario')))) return `${c.id}'s scenario did not read back as written`;
  }
  return null;
}

/**
 * A block that was already there: only its banner must still name the ticket. A
 * person may have fixed a typo in a case since, and that is not a failure.
 */
export function verifyBanner(read: Grid, iid: number): string | null {
  const banner = read[0]?.[0] ?? '';
  return new RegExp(`Ticket #${iid}(?!\\d)`).test(banner) ? null : `the marked banner row no longer says 'Ticket #${iid}' (it says '${clip(banner)}')`;
}

/** The tracker row, read from column A: B links the ticket, C is Done, D is the status, E links the module tab. */
export function verifyTrackerRow(read: string[], cols: Record<string, number>, iid: number, status: string, gid: number): string | null {
  const at = (h: string) => comparable(read[cols[h] ?? -1]);
  if (!new RegExp(`/${iid}(?!\\d)`).test(at(H_TICKET))) return `${H_TICKET} does not link #${iid} (it says '${clip(at(H_TICKET))}')`;
  if (at(H_STATUS) !== STATUS.done) return `${H_STATUS} is '${clip(at(H_STATUS))}', not '${STATUS.done}'`;
  if (at(H_AUTOMATION) !== status) return `${H_AUTOMATION} is '${clip(at(H_AUTOMATION))}', not '${status}'`;
  if (!new RegExp(`gid=${gid}(?!\\d)`).test(at(H_LINK))) return `${H_LINK} does not point at gid ${gid}`;
  return null;
}
