/**
 * The sheet layout rules, pinned against the shapes the real team sheet has:
 * its tab spellings, its tracker's column-A names, its merged sections and the
 * B-column merge that straddles two of them, its per-block sub-headers and its
 * legend. Every grid here mirrors one observed read-only; the tickets in them
 * are invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_HEADERS, COLORS, STATUS, TRACKER_HEADERS, a1Col, automationStatus, deepLink, findHeaderRow,
  findLegendRow, findModuleTab, findSection, hyperlinkFormula, isTrackerTitle, lastUsedRow, legendEnd,
  legendHasLimitation, mapCaseColumns, moduleBlockRequests, moduleDisplayName, moduleTabTitle, moduleTabs,
  newModuleTabRequests, newSheetId, newTrackerTabRequests, normHeader, normaliseModule, ownMarkRequest,
  ownMarkValues, parseOwnMarks, plainText, planLegend, planTrackerPlacement, rgb, trackerRowRequests, trackerTitle,
  verifyBanner, verifyBlock, verifyTrackerRow, MARK_KEY,
  type Grid, type Merge, type SheetCase, type SheetConfig, type SheetRequest, type TabInfo,
} from './sheetlayout.js';

const CFG: SheetConfig = { spreadsheetId: 'sheet-1', trackerTab: 'Test Cases Updates [{year}]', moduleTabPrefix: 'TestCases_' };

const kinds = (rs: SheetRequest[]) => rs.map((r) => Object.keys(r)[0]);
const body = (r: SheetRequest | undefined) => Object.values(r ?? {})[0] as Record<string, any>;

function tab(title: string, sheetId: number, index: number, extra: Partial<TabInfo> = {}): TabInfo {
  return { sheetId, title, index, hidden: false, rowCount: 1000, columnCount: 26, ...extra };
}

function merge(r0: number, r1: number, c0: number, c1: number, sheetId = 7): Merge {
  return { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 };
}

/** A grid of at least `n` rows, with the given rows set. */
function gridOf(n: number, rows: Record<number, string[]>): Grid {
  const length = Math.max(n, ...Object.keys(rows).map((r) => Number(r) + 1));
  return Array.from({ length }, (_, i) => rows[i] ?? []);
}

const CASES: SheetCase[] = [
  { id: 'TC-01', scenario: 'Verify that a saved preference survives a reload', precondition: '', steps: ['Open the profile', 'Save'], expected: 'The preference is kept', automatable: 'yes', reason: 'Plain UI flow' },
  { id: 'TC-02', scenario: 'Verify that the export names the employee', precondition: 'Logged in as HR', steps: ['1. Export the PDF'], expected: 'The PDF names the employee', automatable: 'no', reason: 'PDF content cannot be read by Cypress' },
  { id: 'TC-03', scenario: 'Verify that the reminder email is queued', precondition: '', steps: ['Save'], expected: 'An email is queued', automatable: 'partly', reason: 'The queue is checkable, the email is not' },
];

// ------------------------------------------------------------------ names

test('moduleDisplayName and normaliseModule fold every tab spelling the real sheet uses', () => {
  assert.equal(moduleDisplayName('TestCases_Profile'), 'Profile');
  assert.equal(moduleDisplayName('Test_Cases_Job_Requisition'), 'Job Requisition');
  assert.equal(moduleDisplayName('TestCases - Leave'), 'Leave');
  assert.equal(moduleDisplayName('TestCases _ onBoarding Document'), 'onBoarding Document');
  assert.equal(moduleDisplayName('Testcases Expense Dashboard Uplift(updated)'), 'Expense Dashboard Uplift');
  assert.equal(moduleDisplayName('Team Reviews [Latest]'), 'Team Reviews');
  assert.equal(moduleDisplayName('Training - Latest '), 'Training');
  assert.equal(moduleDisplayName('New Joiners'), 'New Joiners');
  assert.equal(moduleDisplayName('Leave Management - Admin'), 'Leave Management - Admin');
  assert.equal(normaliseModule(moduleDisplayName('Test_Cases_Job_Requisition')), normaliseModule('Job Requisition'));
  assert.equal(normaliseModule(moduleDisplayName('TestCases _ onBoarding Document')), normaliseModule('Onboarding Document'));
});

test('plurals fold both ways, and an empty normalised module matches nothing', () => {
  assert.equal(normaliseModule('Leaves'), normaliseModule('Leave'));
  assert.equal(normaliseModule('Competencies'), normaliseModule('Competency'));
  assert.equal(normaliseModule('Team Review'), normaliseModule('Team Reviews'));
  assert.equal(normaliseModule('Trainings '), normaliseModule('Training'));
  assert.notEqual(normaliseModule('Process'), normaliseModule('Proces'), 'a double s is not a plural');
  assert.equal(normaliseModule('  '), '');
  assert.equal(normaliseModule(moduleDisplayName('Test Cases')), '');
  assert.equal(findModuleTab([tab('Test Cases', 1, 0), tab('Notes', 2, 1)], 'Test Cases', CFG), null);
  // A blank column-A cell must never read as the section of an empty module.
  const grid = gridOf(4, { 0: [...TRACKER_HEADERS], 2: ['', '=HYPERLINK("u","#1 t")', 'Done', 'Not started', 'x'] });
  assert.equal(findSection(grid, findHeaderRow(grid, TRACKER_HEADERS)!, '', { moduleGid: null }), null);
});

test('findModuleTab ignores outdated, hidden and tracker tabs, prefers Latest, and returns the exact title with its trailing space', () => {
  const tabs = [
    tab('Testcases updates', 1, 0),
    tab('Test Cases Updates [2026]', 2, 1),
    tab('Training', 3, 2),
    tab('Training - [Outdated]', 4, 3),
    tab('Training - Latest ', 5, 4),
    tab('TestCases_Profile', 6, 5, { hidden: true }),
    tab('Profile', 7, 6),
    tab('Expenses New(outdated)', 8, 7),
    tab('TestCases_Leave', 9, 8),
    tab('Leave', 10, 9),
  ];
  assert.equal(findModuleTab(tabs, 'Training', CFG)?.title, 'Training - Latest ');
  assert.equal(findModuleTab(tabs, 'Profile', CFG)?.title, 'Profile', 'the hidden tab is not a candidate');
  assert.equal(findModuleTab(tabs, 'Expenses', CFG), null, 'an outdated tab is never written to');
  assert.equal(findModuleTab(tabs, 'Test Cases Updates', CFG), null, 'a tracker is not a module tab');
  assert.equal(findModuleTab(tabs, 'Leaves', CFG)?.title, 'TestCases_Leave', 'the exact title oneshot would create beats index');
  // One entry per module for the prompt: the tab that will actually be written.
  assert.deepEqual(moduleTabs(tabs, CFG), [
    { tab: 'Training - Latest ', module: 'Training' },
    { tab: 'Profile', module: 'Profile' },
    { tab: 'TestCases_Leave', module: 'Leave' },
  ]);
});

test('trackerTitle and isTrackerTitle handle {year} and brackets', () => {
  assert.equal(trackerTitle('Test Cases Updates [{year}]', 2027), 'Test Cases Updates [2027]');
  assert.equal(trackerTitle('TestCases year {year}', 2026), 'TestCases year 2026');
  assert.ok(isTrackerTitle('Test Cases Updates [2026]', 'Test Cases Updates [{year}]'));
  assert.ok(isTrackerTitle(' Test Cases Updates [2019] ', 'Test Cases Updates [{year}]'));
  assert.ok(!isTrackerTitle('Test Cases Updates 2026', 'Test Cases Updates [{year}]'), 'brackets are literal');
  assert.ok(!isTrackerTitle('Test Cases Updates [26]', 'Test Cases Updates [{year}]'));
  assert.ok(isTrackerTitle('TestCases year 2026', 'TestCases year {year}'));
});

test('the tracker header is found on row 1 or row 2, with a trailing space', () => {
  const target: Grid = [['Modules', 'Ticket Updates', 'Test Case Status', 'Automation Status', 'Test Case Link ']];
  assert.deepEqual(findHeaderRow(target, TRACKER_HEADERS), {
    row: 0, cols: { 'Modules': 0, 'Ticket Updates': 1, 'Test Case Status': 2, 'Automation Status': 3, 'Test Case Link': 4 },
  });
  const reference: Grid = [['Test Cases Updates 2026'], ['Modules', 'Ticket Updates', 'Test Case Status', 'Automation Status', 'Test Case Link']];
  assert.equal(findHeaderRow(reference, TRACKER_HEADERS)?.row, 1);
  assert.equal(findHeaderRow([['Modules', 'Ticket Updates']], TRACKER_HEADERS), null);
  assert.equal(findHeaderRow(gridOf(12, { 11: [...TRACKER_HEADERS] }), TRACKER_HEADERS, 10), null, 'only the first 10 rows are searched');
  assert.equal(normHeader(' Test Case Link '), 'testcaselink');
});

// ------------------------------------------------------------------ tracker placement

/** The reference tracker's column A (1-based rows as observed), header on row 2, legend at 128. */
const REAL_SECTIONS: Record<number, string> = {
  4: 'WS Helpdesk', 9: 'Reports', 14: 'Final Settlement ', 19: 'Forms', 24: 'Team Management', 29: 'Home',
  34: 'Costing', 39: 'Expense', 44: 'Costing', 49: 'Analytics', 50: 'Onboarding Document Template',
  51: 'Job Requisition', 56: 'POD', 61: 'Trainings ', 66: 'Project Logs', 72: 'Leaves', 78: 'Allowance',
  84: 'Competencies', 90: 'Profile', 97: 'Invoices', 104: 'Organogram', 111: 'Increments',
  118: 'Phantom shares - stocks', 119: 'Team Review', 122: 'Payroll', 128: 'Legends ',
};

function realTracker(extra: Record<number, string[]> = {}): Grid {
  const rows: Record<number, string[]> = { 1: [...TRACKER_HEADERS] };
  for (const [r, name] of Object.entries(REAL_SECTIONS)) rows[Number(r) - 1] = [name];
  return gridOf(128, { ...rows, ...extra });
}
const HEADER2 = { row: 1, cols: { 'Modules': 0, 'Ticket Updates': 1, 'Test Case Status': 2, 'Automation Status': 3, 'Test Case Link': 4 } };

test('sections are found by name, alias, then the module tab\'s gid in column E', () => {
  const grid = realTracker({ 72: ['', '=HYPERLINK("https://x/-/issues/1","#1")', 'Done', 'Not started', '=HYPERLINK("https://docs.google.com/spreadsheets/d/s/edit#gid=1215400800&range=A2:G9","Leave rows 2–9")'] });
  assert.deepEqual(findSection(grid, HEADER2, 'Leave', { moduleGid: null }), { row: 71, by: 'name' });
  assert.deepEqual(findSection(grid, HEADER2, 'Competency', { moduleGid: null }), { row: 83, by: 'name' });
  assert.deepEqual(findSection(grid, HEADER2, 'Training', { moduleGid: null }), { row: 60, by: 'name' });
  assert.deepEqual(findSection(grid, HEADER2, 'Stocks', { moduleGid: null, aliases: { Stocks: 'phantom shares - STOCKS' } }), { row: 117, by: 'alias' });
  // Named unlike any section and with no alias: the team's own link to the tab finds it.
  assert.deepEqual(findSection(grid, HEADER2, 'Time Off', { moduleGid: 1215400800 }), { row: 71, by: 'gid' });
  assert.equal(findSection(grid, HEADER2, 'Time Off', { moduleGid: 121540080 }), null, 'a gid is matched whole, not as a prefix');
  assert.equal(findSection(grid, HEADER2, 'Brand New', { moduleGid: 5 }), null);
});

test('a free row inside a merged section is filled', () => {
  // Profile A90:A96: row 90 holds a ticket, 91–96 are reserve rows.
  const grid = realTracker({ 89: ['Profile', '=HYPERLINK("https://x/-/issues/7","#7 t")', 'Done', 'Not started', 'link'] });
  const merges = [merge(89, 96, 0, 1)];
  assert.deepEqual(planTrackerPlacement(grid, HEADER2, 'Profile', merges, { moduleGid: null }), { kind: 'fill', row: 90, sectionRow: 89 });
});

test('a row under a column-B merge is not free, and an insert inside one is blocked as layout', () => {
  // Reports A9:A13 and Final Settlement A14:A18, with B11:B15 merged across both.
  const filled = ['x', 'Done', 'Not started', 'link'];
  const grid = realTracker({
    8: ['Reports', ...filled], 9: ['', ...filled], 10: ['', 'merged ticket', '', '', ''],
    13: ['Final Settlement '],
  });
  const merges = [merge(8, 13, 0, 1), merge(13, 18, 0, 1), merge(10, 15, 1, 2)];
  const reports = planTrackerPlacement(grid, HEADER2, 'Reports', merges, { moduleGid: null, tab: 'Test Cases Updates [2026]' });
  assert.equal(reports.kind, 'blocked');
  assert.match((reports as { why: string }).why, /row 14 of 'Test Cases Updates \[2026\]' falls inside the merged range B11:B15/);
  // Rows 14–15 of Final Settlement sit under the same merge; row 16 is the first a person can see.
  assert.deepEqual(planTrackerPlacement(grid, HEADER2, 'Final Settlement', merges, { moduleGid: null }), { kind: 'fill', row: 15, sectionRow: 13 });
});

test('a full section grows by one row and its A merge is extended', () => {
  const full = ['x', 'Done', 'Not started', 'link'];
  const rows: Record<number, string[]> = {};
  for (let r = 77; r <= 82; r++) rows[r] = [r === 77 ? 'Allowance' : '', ...full];
  const grid = realTracker(rows);
  const merges = [merge(77, 83, 0, 1), merge(83, 89, 0, 1)];
  const placement = planTrackerPlacement(grid, HEADER2, 'Allowance', merges, { moduleGid: null });
  assert.deepEqual(placement, { kind: 'insert', row: 83, sectionRow: 77 });
  const { requests, row } = trackerRowRequests({
    sheetId: 7, rowCount: 1099, grid, header: HEADER2, placement, merges, module: 'Allowance', iid: 101,
    title: 'Allowance fix', issueUrl: 'https://x/-/issues/101', status: 'Not started', link: { url: 'u', text: 't' },
  });
  assert.equal(row, 83);
  assert.deepEqual(kinds(requests).slice(0, 3), ['insertDimension', 'unmergeCells', 'mergeCells']);
  assert.deepEqual(body(requests[0]), { range: { sheetId: 7, dimension: 'ROWS', startIndex: 83, endIndex: 84 }, inheritFromBefore: true });
  assert.deepEqual(body(requests[1]).range, { sheetId: 7, startRowIndex: 77, endRowIndex: 83, startColumnIndex: 0, endColumnIndex: 1 });
  assert.deepEqual(body(requests[2]).range, { sheetId: 7, startRowIndex: 77, endRowIndex: 84, startColumnIndex: 0, endColumnIndex: 1 });
  assert.ok(!requests.some((r) => body(r).start?.columnIndex === 0), 'column A of a merged section is left to the merge');
  assert.equal(kinds(requests).at(-1), 'createDeveloperMetadata');
});

test('a new section goes above the legend, or at the end without one', () => {
  const withLegend = realTracker();
  assert.deepEqual(planTrackerPlacement(withLegend, HEADER2, 'Brand New', [], { moduleGid: null }), { kind: 'new-section', row: 127 });
  // The target sheet: header only, so the first section is row 2.
  const target: Grid = [[...TRACKER_HEADERS]];
  const header = findHeaderRow(target, TRACKER_HEADERS)!;
  const placement = planTrackerPlacement(target, header, 'Profile', [], { moduleGid: null });
  assert.deepEqual(placement, { kind: 'new-section', row: 1 });
  const { requests } = trackerRowRequests({
    sheetId: 0, rowCount: 1000, grid: target, header, placement, merges: [], module: '  Profile ', iid: 101, title: 't',
    issueUrl: 'https://x/-/issues/101', status: 'Automation limitation', link: { url: 'u', text: 't' },
  });
  assert.deepEqual(body(requests[0]), { range: { sheetId: 0, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false });
  assert.equal(body(requests[1]).rows[0].values[0].userEnteredValue.stringValue, 'Profile');
  // The last section's merge running over empty reserve rows is stepped past, not split.
  const reserve = gridOf(6, { 0: [...TRACKER_HEADERS], 1: ['Payroll', 'x', 'Done', 'Not started', 'l'] });
  assert.deepEqual(planTrackerPlacement(reserve, header, 'Brand New', [merge(1, 6, 0, 1)], { moduleGid: null }), { kind: 'new-section', row: 6 });
});

// ------------------------------------------------------------------ module blocks

test('mapCaseColumns follows the latest per-block sub-header', () => {
  // Profile: a row 1 that does not describe cases, then sub-headers in C–E.
  const profile = gridOf(720, {
    0: ['Steps', 'Priority', 'PreCondition', 'Action', 'Description', 'Expected'],
    400: ['', 'Test Scenario', 'Pre Condition'],
    716: ['', '', 'Test Scenario', 'Pre Condition', 'Steps'],
    719: ['', 'TC-9', 'Verify that…', '—', '1. x'],
  });
  const p = mapCaseColumns(profile);
  assert.deepEqual(Object.fromEntries(Object.entries(p.col).map(([f, c]) => [f, a1Col(c)])), {
    id: 'B', scenario: 'C', precondition: 'D', steps: 'E', expected: 'F', automatable: 'G', reason: 'H',
  });
  assert.equal(p.fromRow, 716);
  assert.equal(p.subHeader, true);
  // Leave: sub-headers in D–F.
  const leave = mapCaseColumns(gridOf(510, { 503: ['', '', '', 'Test Scenario', 'Pre Condition', 'Steps'] }));
  assert.deepEqual([leave.col.id, leave.col.scenario, leave.col.expected, leave.col.reason].map(a1Col), ['C', 'D', 'G', 'I']);
  // A team column after the sub-header is stepped over, not written under.
  const team = mapCaseColumns(gridOf(120, { 114: ['', '', '', 'Test Scenario', 'Pre Condition', 'Steps', '', '', 'Automation Status'] }));
  assert.deepEqual([team.col.expected, team.col.automatable, team.col.reason].map(a1Col), ['J', 'K', 'L']);
  // Nothing scoring three: A..G, with the block's own sub-header.
  const none = mapCaseColumns([['Steps', 'Priority', 'PreCondition']]);
  assert.deepEqual(none, { col: { id: 0, scenario: 1, precondition: 2, steps: 3, expected: 4, automatable: 5, reason: 6 }, lastCol: 6, fromRow: null, subHeader: true });
});

test('a tab oneshot created maps all seven from row 1, so blocks carry no sub-header', () => {
  const c = mapCaseColumns([[...CASE_HEADERS]]);
  assert.equal(c.fromRow, 0);
  assert.equal(c.subHeader, false);
  assert.equal(c.lastCol, 6);
});

test('moduleBlockRequests inserts first, then values, banner merge, colours by automatable, and marks the banner and last rows', () => {
  // The real Profile tab: 729 rows used, its latest sub-header on row 717.
  const grid = gridOf(729, { 716: ['', '', 'Test Scenario', 'Pre Condition', 'Steps'], 728: ['', 'TC-9', 'last team row'] });
  const columns = mapCaseColumns(grid);
  const plan = moduleBlockRequests({ sheetId: 42, rowCount: 1207, grid, iid: 101, title: 'Profile  fix', cases: CASES, columns });
  assert.deepEqual(kinds(plan.requests), ['insertDimension', 'updateCells', 'mergeCells', 'updateCells', 'createDeveloperMetadata', 'createDeveloperMetadata']);
  // 1-based: spacer 730, banner 731, sub-header 732, cases 733–735.
  assert.deepEqual(body(plan.requests[0]), { range: { sheetId: 42, dimension: 'ROWS', startIndex: 729, endIndex: 735 }, inheritFromBefore: false });
  assert.equal(plan.bannerRow, 730);
  assert.equal(plan.firstCaseRow, 732);
  assert.equal(plan.lastRow, 734);
  assert.equal(plan.a1, 'A731:H735');
  const banner = body(plan.requests[1]);
  assert.deepEqual(banner.start, { sheetId: 42, rowIndex: 730, columnIndex: 0 });
  assert.equal(banner.rows[0].values[0].userEnteredValue.stringValue, 'Ticket #101: Profile fix');
  assert.deepEqual(banner.rows[0].values[0].userEnteredFormat.backgroundColorStyle.rgbColor, rgb(COLORS.newCases));
  assert.deepEqual(body(plan.requests[2]).range, { sheetId: 42, startRowIndex: 730, endRowIndex: 731, startColumnIndex: 0, endColumnIndex: 8 });
  const rows = body(plan.requests[3]);
  assert.deepEqual(rows.start, { sheetId: 42, rowIndex: 731, columnIndex: 1 });
  const text = (r: number, c: number) => rows.rows[r].values[c].userEnteredValue.stringValue;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((c) => text(0, c)), [...CASE_HEADERS]);
  assert.equal(text(1, 0), 'TC-01');
  assert.equal(text(1, 2), '—', 'an empty precondition reads as a dash');
  assert.equal(text(1, 3), '1. Open the profile\n2. Save');
  assert.equal(text(2, 3), '1. Export the PDF', 'a model\'s own numbering is not doubled');
  const bg = (r: number) => rows.rows[r].values[5].userEnteredFormat.backgroundColorStyle.rgbColor;
  assert.deepEqual([bg(1), bg(2), bg(3)], [rgb(COLORS.yes), rgb(COLORS.no), rgb(COLORS.partly)]);
  const marks = plan.requests.slice(4).map((r) => body(r).developerMetadata);
  assert.deepEqual(marks.map((m) => [m.metadataKey, m.metadataValue, m.location.dimensionRange.startIndex]), [
    [MARK_KEY, 'block:101', 730], [MARK_KEY, 'block-end:101', 734],
  ]);
});

test('plainText takes markdown emphasis and code backticks off, and leaves code, snake_case and lone stars alone', () => {
  assert.equal(plainText('Click **Save** on the __Basic Info__ tab'), 'Click Save on the Basic Info tab');
  assert.equal(plainText('Open the *Notices* dropdown, then _Home_'), 'Open the Notices dropdown, then Home');
  assert.equal(plainText('Upload through `selectFile` and ``a `b` c``'), 'Upload through selectFile and a `b` c');
  assert.equal(plainText('The `__init__.py` file and `**kwargs`'), 'The __init__.py file and **kwargs', 'inside code nothing is stripped');
  assert.equal(plainText('Set blocked_team_updates and user_id'), 'Set blocked_team_updates and user_id');
  assert.equal(plainText('5 * 3 = 15, and a lone * stays'), '5 * 3 = 15, and a lone * stays');
  assert.equal(plainText('No markdown here.'), 'No markdown here.');
});

test('case text reaches the sheet as plain text, and reads back as written', () => {
  const md: SheetCase[] = [{
    id: 'TC-01', scenario: 'Verify that the **Blocked Team Updates** selection persists', precondition: 'On **Profile > Basic Info**',
    steps: ['Open the **Blocked Team Updates** dropdown', 'Click `Save`'], expected: 'The *selected* option is shown',
    automatable: 'yes', reason: 'Checked through `cy.get`',
  }];
  const columns = mapCaseColumns([[...CASE_HEADERS]]);
  const plan = moduleBlockRequests({ sheetId: 7, rowCount: 100, grid: [[...CASE_HEADERS]], iid: 101, title: 'x', cases: md, columns });
  const cells = plan.requests.map(body).find((b) => b.rows && b.start?.rowIndex === plan.firstCaseRow);
  assert.ok(cells, 'the case rows are written');
  const text = (c: number) => cells.rows[0].values[c].userEnteredValue.stringValue;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(text), [
    'TC-01', 'Verify that the Blocked Team Updates selection persists', 'On Profile > Basic Info',
    '1. Open the Blocked Team Updates dropdown\n2. Click Save', 'The selected option is shown', 'yes', 'Checked through cy.get',
  ]);
  // The read-back compares against what was written, not against the markdown.
  assert.equal(verifyBlock([['Ticket #101: x'], ['TC-01', text(1)]], md, 101, columns), null);
});

test('a block at the very end of the grid appends rows instead of inserting', () => {
  const grid = gridOf(50, { 0: [...CASE_HEADERS], 49: ['TC-1', 'x'] });
  const plan = moduleBlockRequests({ sheetId: 3, rowCount: 50, grid, iid: 101, title: 't', cases: CASES, columns: mapCaseColumns(grid) });
  assert.deepEqual(plan.requests[0], { appendDimension: { sheetId: 3, dimension: 'ROWS', length: 5 } });
  assert.ok(!kinds(plan.requests).includes('insertDimension'));
  // Partly inside: what fits is inserted, the rest appended.
  const near = moduleBlockRequests({ sheetId: 3, rowCount: 52, grid, iid: 101, title: 't', cases: CASES, columns: mapCaseColumns(grid) });
  assert.deepEqual(near.requests.slice(0, 2), [
    { insertDimension: { range: { sheetId: 3, dimension: 'ROWS', startIndex: 50, endIndex: 52 }, inheritFromBefore: false } },
    { appendDimension: { sheetId: 3, dimension: 'ROWS', length: 3 } },
  ]);
});

test('a new tab\'s block starts right under its header with no spacer', () => {
  const grid: Grid = [[...CASE_HEADERS]];
  const plan = moduleBlockRequests({ sheetId: 9, rowCount: 1000, grid, iid: 101, title: 't', cases: CASES, columns: mapCaseColumns(grid) });
  assert.equal(plan.bannerRow, 1);
  assert.equal(plan.firstCaseRow, 2);
  assert.equal(plan.a1, 'A2:G5');
  assert.deepEqual(body(plan.requests[0]).range, { sheetId: 9, dimension: 'ROWS', startIndex: 1, endIndex: 5 });
});

// ------------------------------------------------------------------ marks

test('own marks are parsed from a metadata search; a human \'Ticket #iid:\' block and a human tracker row are not ours', () => {
  const response = {
    matchedDeveloperMetadata: [
      // Proto JSON drops zeros: sheetId 0 and row 0 arrive as absent fields.
      { developerMetadata: { metadataKey: MARK_KEY, metadataValue: 'tracker:101', location: { locationType: 'ROW', dimensionRange: { dimension: 'ROWS', endIndex: 1 } } } },
      { developerMetadata: { metadataKey: MARK_KEY, metadataValue: 'block:101', location: { dimensionRange: { sheetId: 42, dimension: 'ROWS', startIndex: 729, endIndex: 730 } } } },
      { developerMetadata: { metadataKey: MARK_KEY, metadataValue: 'block-end:101', location: { dimensionRange: { sheetId: 42, dimension: 'ROWS', startIndex: 733, endIndex: 734 } } } },
      { developerMetadata: { metadataKey: MARK_KEY, metadataValue: 'block:1011', location: { dimensionRange: { sheetId: 42, startIndex: 3 } } } },
      { developerMetadata: { metadataKey: 'someone-else', metadataValue: 'block:101', location: { dimensionRange: { sheetId: 42, startIndex: 5 } } } },
      { developerMetadata: { metadataKey: MARK_KEY, metadataValue: 'block:101', location: { dimensionRange: { sheetId: 42, dimension: 'COLUMNS', startIndex: 2 } } } },
    ],
  };
  assert.deepEqual(parseOwnMarks(response, 101), [
    { kind: 'tracker', sheetId: 0, row: 0 },
    { kind: 'block', sheetId: 42, row: 729 },
    { kind: 'block-end', sheetId: 42, row: 733 },
  ]);
  // A sheet with only the team's own `Ticket #101:` banner and row has no marks at all.
  assert.deepEqual(parseOwnMarks({}, 101), []);
  assert.deepEqual(parseOwnMarks(null, 101), []);
  assert.deepEqual(ownMarkValues(101), ['block:101', 'block-end:101', 'tracker:101']);
  assert.deepEqual(ownMarkRequest(5, 12, 'tracker', 101), {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: MARK_KEY, metadataValue: 'tracker:101', visibility: 'DOCUMENT',
        location: { dimensionRange: { sheetId: 5, dimension: 'ROWS', startIndex: 12, endIndex: 13 } },
      },
    },
  });
});

// ------------------------------------------------------------------ values and links

test('hyperlinkFormula doubles quotes (a real title has them)', () => {
  assert.equal(
    hyperlinkFormula('https://x/-/issues/101', '#101 Fix "preferences" tab'),
    '=HYPERLINK("https://x/-/issues/101","#101 Fix ""preferences"" tab")',
  );
  assert.equal(hyperlinkFormula('u', 'two\nlines'), '=HYPERLINK("u","two lines")');
});

test('deepLink points at the gid and the block range', () => {
  assert.equal(deepLink('sheet-1', 1407354763, 'A730:H734'), 'https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=1407354763&range=A730:H734');
  assert.equal(a1Col(0), 'A');
  assert.equal(a1Col(25), 'Z');
  assert.equal(a1Col(26), 'AA');
  assert.equal(a1Col(27), 'AB');
});

test('automationStatus: any yes or partly means Not started; all no means Automation limitation; the status strings are byte-exact', () => {
  assert.equal(automationStatus(CASES), 'Not started');
  assert.equal(automationStatus(CASES.filter((c) => c.automatable === 'partly')), 'Not started');
  assert.equal(automationStatus(CASES.filter((c) => c.automatable === 'no')), 'Automation limitation');
  // The real tracker's C/D validation is STRICT ONE_OF_LIST: these must match it byte for byte.
  assert.deepEqual(STATUS, { done: 'Done', notStarted: 'Not started', limitation: 'Automation limitation' });
});

test('the legend is added when absent, gets one Automation limitation line when it lacks one, and is left alone otherwise', () => {
  const target: Grid = [[...TRACKER_HEADERS]];
  const full = planLegend({ sheetId: 0, grid: target, colA: 0, rowCount: 1000, placedRow: 1, inserted: true });
  assert.equal(full.added, 'full');
  // Row 2 is the new section, row 3 blank, the legend from row 4 (0-based 3).
  assert.equal(body(full.requests[0]).start.rowIndex, 3);
  assert.equal(body(full.requests[0]).rows[0].values[0].userEnteredValue.stringValue, 'Legends');
  const lines = body(full.requests[1]).rows as Array<{ values: Array<Record<string, any>> }>;
  assert.deepEqual(lines.map((l) => l.values[0]!.userEnteredFormat.backgroundColorStyle.rgbColor), [rgb('#b6d7a8'), rgb('#ff9900'), rgb('#ff0000')]);
  assert.match(lines[2]!.values[1]!.userEnteredValue.stringValue, /Automation limitation/);

  // The reference legend: its red means Failures, so one line is added after its last line.
  const reference = realTracker({ 128: ['', 'Green cells means Done'], 129: ['', 'Orange tabs or cells means new changes or TC added'], 130: ['', 'Red means Failures '], 131: ['', 'Purple means Next targeted modules'] });
  const legendRow = findLegendRow(reference, 0)!;
  assert.equal(legendRow, 127);
  assert.equal(legendEnd(reference, legendRow, 0), 131);
  assert.equal(legendHasLimitation(reference, legendRow, 131), false);
  const line = planLegend({ sheetId: 7, grid: reference, colA: 0, rowCount: 1099, placedRow: 90, inserted: false });
  assert.equal(line.added, 'line');
  assert.deepEqual(kinds(line.requests), ['insertDimension', 'updateCells', 'updateCells']);
  assert.equal(body(line.requests[0]).range.startIndex, 132);
  // A row this batch inserts above the legend moves it down one.
  const shifted = planLegend({ sheetId: 7, grid: reference, colA: 0, rowCount: 1099, placedRow: 127, inserted: true });
  assert.equal(body(shifted.requests[0]).range.startIndex, 133);

  const complete = realTracker({ 128: ['', 'Red in Automation Status means Automation limitation'] });
  assert.deepEqual(planLegend({ sheetId: 7, grid: complete, colA: 0, rowCount: 1099, placedRow: 90, inserted: false }), { requests: [], added: null });
});

test('newModuleTabRequests: orange tab, frozen header, #44546a white bold; the title is cleaned and capped at 100', () => {
  assert.equal(moduleTabTitle('TestCases_', '  Team \n  Management '), 'TestCases_Team Management');
  assert.equal(moduleTabTitle('TestCases_', 'x'.repeat(200)).length, 100);
  assert.throws(() => moduleTabTitle('TestCases_', '  '), /module name/);
  const rs = newModuleTabRequests(77, 'TestCases_Profile');
  assert.deepEqual(body(rs[0]).properties, {
    sheetId: 77, title: 'TestCases_Profile', tabColorStyle: { rgbColor: rgb('#ff9900') },
    gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 },
  });
  const header = body(rs[1]);
  assert.deepEqual(header.start, { sheetId: 77, rowIndex: 0, columnIndex: 0 });
  const cells = header.rows[0].values as Array<Record<string, any>>;
  assert.deepEqual(cells.map((c) => c.userEnteredValue.stringValue), [...CASE_HEADERS]);
  assert.deepEqual(cells[0]!.userEnteredFormat.backgroundColorStyle.rgbColor, rgb('#44546a'));
  assert.deepEqual(cells[0]!.userEnteredFormat.textFormat.foregroundColorStyle.rgbColor, rgb('#ffffff'));
  assert.equal(cells[0]!.userEnteredFormat.textFormat.bold, true);
  assert.deepEqual(rs.slice(2).map((r) => body(r).properties.pixelSize), [70, 320, 260, 420, 320, 110, 280]);
  // A tracker oneshot creates has no tab colour and the five tracker headers.
  const tr = newTrackerTabRequests(78, 'TestCases year 2027');
  assert.equal(body(tr[0]).properties.tabColorStyle, undefined);
  assert.deepEqual((body(tr[1]).rows[0].values as Array<Record<string, any>>).map((c) => c.userEnteredValue.stringValue), [...TRACKER_HEADERS]);
  // Chosen ids are stable, positive, and never collide.
  assert.equal(newSheetId([], 12345), newSheetId([], 12345));
  assert.notEqual(newSheetId([12346], 12345), 12346);
  assert.ok(newSheetId([0], 0) > 0);
});

test('verifyBlock and verifyTrackerRow catch a missing case and a wrong status; verifyBanner accepts an edited case', () => {
  const columns = mapCaseColumns([[...CASE_HEADERS]]);
  const read: Grid = [
    ['Ticket #101: Profile fix'],
    ['TC-01', CASES[0]!.scenario],
    ['TC-02', CASES[1]!.scenario],
    ['TC-03', CASES[2]!.scenario],
  ];
  assert.equal(verifyBlock(read, CASES, 101, columns), null);
  assert.match(verifyBlock([read[0]!, read[1]!, read[3]!], CASES, 101, columns) ?? '', /case row 2 should be TC-02/);
  assert.match(verifyBlock([['Ticket #1011: other'], ...read.slice(1)], CASES, 101, columns) ?? '', /banner/);
  const edited: Grid = [['Ticket #101: Profile fix'], ['TC-01', 'Verify that a person fixed this typo']];
  assert.notEqual(verifyBlock(edited, CASES, 101, columns), null);
  assert.equal(verifyBanner(edited, 101), null);
  assert.match(verifyBanner([['Ticket #1012: x']], 101) ?? '', /no longer says/);

  const cols = HEADER2.cols;
  const row = ['', '=HYPERLINK("https://x/-/issues/101","#101 t")', 'Done', 'Not started', '=HYPERLINK("https://docs.google.com/spreadsheets/d/s/edit#gid=42&range=A2:G4","t")'];
  assert.equal(verifyTrackerRow(row, cols, 101, 'Not started', 42), null);
  assert.match(verifyTrackerRow(row, cols, 101, 'Automation limitation', 42) ?? '', /Automation Status is 'Not started'/);
  assert.match(verifyTrackerRow([...row.slice(0, 2), 'Pending', ...row.slice(3)], cols, 101, 'Not started', 42) ?? '', /Test Case Status/);
  assert.match(verifyTrackerRow(row, cols, 10, 'Not started', 42) ?? '', /does not link #10/);
  assert.match(verifyTrackerRow(row, cols, 101, 'Not started', 4) ?? '', /gid 4/);
});

test('lastUsedRow ignores trailing blank and whitespace-only rows', () => {
  assert.equal(lastUsedRow([]), -1);
  assert.equal(lastUsedRow([['a'], [''], ['  ']]), 0);
});
