/**
 * Google Sheets I/O for the automation mode: service-account auth, the four
 * REST calls it needs, and `writeApprovedCases`, which fetches, asks
 * sheetlayout.ts what to write, posts it, and reads it back.
 *
 * Decisions that shape this file:
 *
 * 1. No googleapis dependency. A service account's token is one RS256 JWT
 *    (node:crypto signs it) exchanged at the token endpoint, and the Sheets API
 *    is plain JSON over fetch. Only the Sheets API is used: Drive is disabled for
 *    the service account.
 *
 * 2. Nothing secret is ever logged or returned. Errors name the key FILE and the
 *    service account's email, never the key, the JWT or the token. JSON.parse's
 *    own message is not passed on, because Node quotes the text it choked on.
 *
 * 3. Failures are classified, not thrown, so the runner can tell "share the
 *    sheet" (permission) from "Google is down" (server, retried) from "a person
 *    has to fix a merge" (layout). Only a 429 or 503 is retried inside a call
 *    (Retry-After, at most twice); a 401 drops the cached token and retries once.
 *
 * 4. The dry-run switch and every piece of config are parameters. This module
 *    imports only `log`, so tests never load config.ts, and a dry run is exactly
 *    the real run minus the two batchUpdate POSTs.
 */
import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from '../lib/log.js';
import {
  CASE_HEADERS, TRACKER_HEADERS, a1Col, automationStatus, deepLink, ensureColumns, findHeaderRow,
  findModuleTab, mapCaseColumns, moduleBlockRequests, moduleTabTitle, moduleTabs, newModuleTabRequests,
  newSheetId, newTrackerTabRequests, ownMarkValues, parseOwnMarks, planLegend, planTrackerPlacement,
  trackerRowRequests, trackerTitle, verifyBanner, verifyBlock, verifyTrackerRow, MARK_KEY,
  type CaseColumns, type Grid, type HeaderRow, type Merge, type OwnMark, type SheetCase, type SheetConfig,
  type SheetRequest, type TabInfo,
} from './sheetlayout.js';

export interface ServiceAccount { client_email: string; private_key: string; private_key_id?: string; token_uri?: string }
export type SheetsFail = 'auth' | 'permission' | 'notfound' | 'network' | 'server' | 'client' | 'layout' | 'readback';
export type SheetsResult<T> = { ok: true; data: T } | { ok: false; kind: SheetsFail; status: number; error: string };

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Full read-write: the conductor writes the approved cases. */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TIMEOUT_MS = 30_000;
/** A 429 or 503 is waited out this many times inside one call; after that the runner retries next tick. */
const MAX_WAITS = 2;

type Fail = Extract<SheetsResult<never>, { ok: false }>;

function fail(kind: SheetsFail, error: string, status = 0): Fail {
  return { ok: false, kind, status, error: error.slice(0, 500) };
}

// ------------------------------------------------------------------ auth

/** Reads and checks the key file. Throws naming the file, never the key. */
export function loadServiceAccount(file: string): ServiceAccount {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the Google service account file ${file} (${(err as NodeJS.ErrnoException).code ?? 'read error'})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`the Google service account file ${file} is not valid JSON`);
  }
  const sa = (raw ?? {}) as Record<string, unknown>;
  if (typeof sa.client_email !== 'string' || !sa.client_email) throw new Error(`the Google service account file ${file} has no client_email`);
  if (typeof sa.private_key !== 'string' || !sa.private_key) throw new Error(`the Google service account file ${file} has no private_key`);
  return {
    client_email: sa.client_email,
    private_key: sa.private_key,
    ...(typeof sa.private_key_id === 'string' && sa.private_key_id ? { private_key_id: sa.private_key_id } : {}),
    ...(typeof sa.token_uri === 'string' && sa.token_uri ? { token_uri: sa.token_uri } : {}),
  };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** The RS256 assertion a service account trades for an access token, valid for one hour from `nowSec`. */
export function signJwt(sa: ServiceAccount, scope: string, nowSec: number): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, scope, aud: sa.token_uri ?? TOKEN_URI, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Tokens by resolved key-file path; `exp` in epoch ms. */
const tokens = new Map<string, { token: string; exp: number }>();

/**
 * How long to wait on a 429/503: Retry-After in seconds (or an HTTP date),
 * capped at 30s so a call never parks a tick for long; 5s when absent.
 */
export function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === '') return 5_000;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return 5_000;
  return Math.min(30_000, Math.max(0, ms));
}

function classify(status: number): SheetsFail {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'notfound';
  if (status === 429 || status >= 500) return 'server';
  return 'client';
}

/** Google's own words for a failure (`error.message`, or an OAuth `error: error_description`), never more than a line. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (j.error && typeof j.error === 'object' && typeof (j.error as { message?: unknown }).message === 'string') {
      return (j.error as { message: string }).message.slice(0, 300);
    }
    if (typeof j.error === 'string') {
      return `${j.error}${typeof j.error_description === 'string' ? `: ${j.error_description}` : ''}`.slice(0, 300);
    }
  } catch { /* not JSON: fall through to the raw text */ }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** One request with a 30s deadline, retrying 429/503 per Retry-After. Returns the body text on 2xx. */
async function send(url: string, init: RequestInit): Promise<SheetsResult<string>> {
  for (let waited = 0; ; waited++) {
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      text = await res.text();
    } catch (err) {
      // undici's own message is only "fetch failed"; the cause says which
      // (DNS, refused, reset), and that is the part an operator can act on.
      const e = err as Error & { cause?: { code?: unknown; message?: unknown } };
      const cause = e.cause ? String(e.cause.code ?? e.cause.message ?? '') : '';
      return fail('network', e.name === 'AbortError' ? `no answer within ${TIMEOUT_MS / 1000}s` : `${e.message}${cause ? ` (${cause})` : ''}`);
    } finally {
      clearTimeout(killer);
    }
    if (status >= 200 && status < 300) return { ok: true, data: text };
    if ((status === 429 || status === 503) && waited < MAX_WAITS) {
      const ms = retryAfterMs(retryAfter);
      log.warn(`sheets: Google answered ${status} — retrying in ${Math.round(ms / 100) / 10}s`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    return fail(classify(status), errorText(text), status);
  }
}

/**
 * A Sheets access token for the key file, cached until 60s before it expires.
 * Every failure to get one is `auth` except an outage (`server`, `network`): a
 * bad key, a revoked account or a wrong clock never heal by waiting.
 */
export async function accessToken(saFile: string): Promise<SheetsResult<string>> {
  const key = resolve(saFile);
  const hit = tokens.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return { ok: true, data: hit.token };
  let sa: ServiceAccount;
  let jwt: string;
  try {
    sa = loadServiceAccount(saFile);
  } catch (err) {
    return fail('auth', (err as Error).message);
  }
  try {
    jwt = signJwt(sa, SHEETS_SCOPE, Math.floor(Date.now() / 1000));
  } catch {
    return fail('auth', `the private key in ${saFile} could not sign a token request`);
  }
  const res = await send(sa.token_uri ?? TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) {
    const kind = res.kind === 'server' || res.kind === 'network' ? res.kind : 'auth';
    return fail(kind, `Google refused a token for ${sa.client_email}: ${res.error}`, res.status);
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(res.data) as typeof body;
  } catch {
    return fail('auth', `the token answer for ${sa.client_email} was not JSON`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token) return fail('auth', `the token answer for ${sa.client_email} had no access_token`);
  const secs = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokens.set(key, { token: body.access_token, exp: Date.now() + secs * 1000 });
  return { ok: true, data: body.access_token };
}

/** An authorised Sheets call, parsed. A 401 means the cached token went bad: drop it and try once more. */
async function call<T>(method: 'GET' | 'POST', url: string, saFile: string, body?: unknown): Promise<SheetsResult<T>> {
  let res: SheetsResult<string> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken(saFile);
    if (!tok.ok) return tok;
    res = await send(url, {
      method,
      headers: { Authorization: `Bearer ${tok.data}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok || res.status !== 401) break;
    tokens.delete(resolve(saFile));
  }
  if (!res || !res.ok) return res ?? fail('network', 'no request was made');
  try {
    return { ok: true, data: (res.data ? JSON.parse(res.data) : {}) as T };
  } catch {
    return fail('server', 'Google answered with something that is not JSON', 200);
  }
}

// ------------------------------------------------------------------ the four calls

/** `'Tab'` for an A1 range: always quoted, inner quotes doubled, the EXACT title (trailing spaces kept). */
function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

const SPREADSHEET_FIELDS = 'properties.title,sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)),merges)';

/**
 * The spreadsheet's title, tabs and merges (flattened, each with its tab's
 * sheetId). Proto JSON omits zeros, so an absent sheetId/index/row is 0.
 */
export async function getSpreadsheet(id: string, saFile: string): Promise<SheetsResult<{ title: string; tabs: TabInfo[]; merges: Merge[] }>> {
  const res = await call<{ properties?: { title?: string }; sheets?: unknown[] }>(
    'GET', `${BASE}/${encodeURIComponent(id)}?fields=${encodeURIComponent(SPREADSHEET_FIELDS)}`, saFile);
  if (!res.ok) return res;
  const tabs: TabInfo[] = [];
  const merges: Merge[] = [];
  for (const sheet of res.data.sheets ?? []) {
    const s = (sheet ?? {}) as { properties?: Record<string, unknown>; merges?: unknown[] };
    const p = s.properties ?? {};
    const grid = (p.gridProperties ?? {}) as Record<string, unknown>;
    const sheetId = Number(p.sheetId ?? 0);
    tabs.push({
      sheetId,
      title: String(p.title ?? ''),
      index: Number(p.index ?? 0),
      hidden: p.hidden === true,
      rowCount: Number(grid.rowCount ?? 0),
      columnCount: Number(grid.columnCount ?? 0),
    });
    for (const m of s.merges ?? []) {
      const r = (m ?? {}) as Record<string, unknown>;
      merges.push({
        sheetId,
        startRowIndex: Number(r.startRowIndex ?? 0),
        endRowIndex: Number(r.endRowIndex ?? 0),
        startColumnIndex: Number(r.startColumnIndex ?? 0),
        endColumnIndex: Number(r.endColumnIndex ?? 0),
      });
    }
  }
  return { ok: true, data: { title: String(res.data.properties?.title ?? ''), tabs, merges } };
}

/** A range's cells as text, FORMULA render (so a HYPERLINK reads as its formula), rows as rows. */
export async function getValues(id: string, a1: string, saFile: string): Promise<SheetsResult<Grid>> {
  const res = await call<{ values?: unknown[] }>(
    'GET', `${BASE}/${encodeURIComponent(id)}/values/${encodeURIComponent(a1)}?valueRenderOption=FORMULA&majorDimension=ROWS`, saFile);
  if (!res.ok) return res;
  const grid = (res.data.values ?? []).map((row) => (Array.isArray(row) ? row : []).map((c) => (c === null || c === undefined ? '' : String(c))));
  return { ok: true, data: grid };
}

/** POST {base}/{id}/developerMetadata:search for ownMarkValues(iid). Read-only (works in dry run). */
export async function searchOwnMarks(id: string, iid: number, saFile: string): Promise<SheetsResult<OwnMark[]>> {
  const res = await call<unknown>('POST', `${BASE}/${encodeURIComponent(id)}/developerMetadata:search`, saFile, {
    dataFilters: ownMarkValues(iid).map((v) => ({ developerMetadataLookup: { metadataKey: MARK_KEY, metadataValue: v } })),
  });
  if (!res.ok) return res;
  return { ok: true, data: parseOwnMarks(res.data, iid) };
}

/**
 * dryRun → logs `[dry-run] would send <n> requests to '<tab>'`, ok:true, no call. A parameter, not DRY_RUN: this module imports only `log`.
 * `dryRunSink`, when given, also receives the full request list a dry run did not send: the log
 * line names only the first few request kinds, and a rehearsal is read for exactly what would
 * have been written.
 */
export async function batchUpdate(
  id: string, requests: SheetRequest[], saFile: string,
  o: { dryRun: boolean; tab: string; dryRunSink?: DryRunSink },
): Promise<SheetsResult<unknown>> {
  if (requests.length === 0) return { ok: true, data: null };
  if (o.dryRun) {
    log.info(`[dry-run] would send ${requests.length} requests to '${o.tab}'`, requests.slice(0, 10).map((r) => Object.keys(r)[0]));
    try { o.dryRunSink?.(o.tab, requests); } catch (err) { log.warn(`[dry-run] could not keep the requests for '${o.tab}'`, { error: (err as Error).message }); }
    return { ok: true, data: null };
  }
  return call<unknown>('POST', `${BASE}/${encodeURIComponent(id)}:batchUpdate`, saFile, { requests, includeSpreadsheetInResponse: false });
}

/** The sheet's module tabs by display name: a required input to the authoring prompt. */
export async function listModuleTabs(cfg: SheetConfig, saFile: string): Promise<SheetsResult<Array<{ tab: string; module: string }>>> {
  const res = await getSpreadsheet(cfg.spreadsheetId, saFile);
  if (!res.ok) return res;
  return { ok: true, data: moduleTabs(res.data.tabs, cfg) };
}

// ------------------------------------------------------------------ writeApprovedCases

export interface SheetWriteInput { iid: number; title: string; issueUrl: string; module: string; cases: SheetCase[]; year: number }
/** Receives what a dry run would have sent to one tab, in order. */
export type DryRunSink = (tab: string, requests: SheetRequest[]) => void;
export interface SheetWriteOptions {
  dryRun: boolean;
  /** Dry run only: handed each batch that was not sent, so a rehearsal can keep it. */
  dryRunSink?: DryRunSink;
}
export interface SheetWriteResult {
  spreadsheetId: string;
  moduleTab: string; moduleGid: number; blockRange: string; blockLink: string;
  trackerTab: string; trackerGid: number; trackerRow: number /* 1-based */; trackerLink: string;
  automationStatus: 'Not started' | 'Automation limitation';
  /** legend: the colour key, or its missing Automation limitation line, was added. */
  created: { moduleTab: boolean; trackerTab: boolean; section: boolean; legend: boolean };
  alreadyThere: { block: boolean; trackerRow: boolean };
  dryRun: boolean;
}

/** A stable seed for a new tab's sheetId, so a retried batch plans the same id. */
function seedOf(title: string): number {
  return createHash('sha256').update(title).digest().readUInt32BE(0);
}

interface BlockAt { bannerRow: number; lastRow: number; lastCol: number; a1: string }

/**
 * Write one approved ticket's cases: its block on the module tab (batch 1),
 * then its row on the year's tracker (batch 2), then read both back.
 *
 * Everything is read and planned BEFORE the first write, so a tracker the
 * layout cannot take (no header row, a merge in the way) fails with nothing
 * written. Each batch is atomic and carries its own ownership marks, so a crash
 * between the two is resumed by finding batch 1's marks and sending only batch 2.
 * Never throws.
 */
export async function writeApprovedCases(
  input: SheetWriteInput, cfg: SheetConfig, saFile: string, opts: SheetWriteOptions,
): Promise<SheetsResult<SheetWriteResult>> {
  try {
    return await write(input, cfg, saFile, opts);
  } catch (err) {
    return fail('client', `the sheet write stopped on an internal error: ${(err as Error).message}`);
  }
}

async function write(input: SheetWriteInput, cfg: SheetConfig, saFile: string, opts: SheetWriteOptions): Promise<SheetsResult<SheetWriteResult>> {
  const id = cfg.spreadsheetId;
  const { iid } = input;

  // 1. Metadata and our own marks.
  const meta = await getSpreadsheet(id, saFile);
  if (!meta.ok) return meta;
  const found = await searchOwnMarks(id, iid, saFile);
  if (!found.ok) return found;
  const { tabs, merges } = meta.data;
  const marks = found.data;
  const mergesOf = (sheetId: number) => merges.filter((m) => m.sheetId === sheetId);
  const usedIds = tabs.map((t) => t.sheetId);

  // 2a. The module tab: where our block already is, else the module's tab, else a new one.
  const blockMark = marks.find((m) => m.kind === 'block' && tabs.some((t) => t.sheetId === m.sheetId)) ?? null;
  let moduleTab = blockMark ? tabs.find((t) => t.sheetId === blockMark.sheetId) ?? null : findModuleTab(tabs, input.module, cfg);
  const moduleIsNew = moduleTab === null;
  if (!moduleTab) {
    let title: string;
    try {
      title = moduleTabTitle(cfg.moduleTabPrefix, input.module);
    } catch {
      return fail('layout', `the approved cases name no module, so there is no tab to write them to`);
    }
    const clash = tabs.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
    if (clash) {
      return fail('layout', `a tab named '${clash.title}' exists but cannot take cases (it is hidden, outdated or a tracker); rename or unhide it`);
    }
    moduleTab = { sheetId: newSheetId(usedIds, seedOf(title)), title, index: tabs.length, hidden: false, rowCount: 1000, columnCount: 26 };
  }
  const moduleGid = moduleTab.sheetId;

  // 2b. The tracker tab for the approval's year.
  const trackerName = trackerTitle(cfg.trackerTab, input.year);
  let trackerTab = tabs.find((t) => t.title.trim() === trackerName.trim()) ?? null;
  const trackerIsNew = trackerTab === null;
  if (!trackerTab) {
    trackerTab = {
      sheetId: newSheetId([...usedIds, moduleGid], seedOf(trackerName)),
      title: trackerName, index: tabs.length + 1, hidden: false, rowCount: 1000, columnCount: 26,
    };
  }

  // 3. The module block: found by its marks, or planned at the end of the tab.
  let block: BlockAt;
  let columns: CaseColumns | null = null;
  let batch1: SheetRequest[] = [];
  if (blockMark) {
    const endMark = marks.find((m) => m.kind === 'block-end' && m.sheetId === blockMark.sheetId && m.row >= blockMark.row);
    const endRow = endMark ? endMark.row : blockMark.row;
    // The banner is merged across the block's columns, so the merge says how wide it is.
    const banner = mergesOf(moduleGid).find((m) => m.startRowIndex === blockMark.row && m.startColumnIndex === 0);
    let lastCol: number;
    if (banner) {
      lastCol = banner.endColumnIndex - 1;
    } else {
      const g = await getValues(id, `${quoteTab(moduleTab.title)}!A1:Z`, saFile);
      if (!g.ok) return g;
      lastCol = mapCaseColumns(g.data).lastCol;
    }
    block = { bannerRow: blockMark.row, lastRow: endRow, lastCol, a1: `A${blockMark.row + 1}:${a1Col(lastCol)}${endRow + 1}` };
  } else {
    let grid: Grid;
    if (moduleIsNew) {
      grid = [[...CASE_HEADERS]];
    } else {
      const g = await getValues(id, `${quoteTab(moduleTab.title)}!A1:Z`, saFile);
      if (!g.ok) return g;
      grid = g.data;
    }
    columns = mapCaseColumns(grid);
    const plan = moduleBlockRequests({ sheetId: moduleGid, rowCount: moduleTab.rowCount, grid, iid, title: input.title, cases: input.cases, columns });
    batch1 = [
      ...(moduleIsNew ? newModuleTabRequests(moduleGid, moduleTab.title) : ensureColumns(moduleGid, moduleTab.columnCount, plan.lastCol)),
      ...plan.requests,
    ];
    block = plan;
  }

  // 4. The tracker row: found by its mark, or planned. Planned before any write.
  let tGrid: Grid;
  let header: HeaderRow;
  if (trackerIsNew) {
    tGrid = [[...TRACKER_HEADERS]];
    header = { row: 0, cols: Object.fromEntries(TRACKER_HEADERS.map((h, i) => [h, i])) };
  } else {
    const g = await getValues(id, `${quoteTab(trackerTab.title)}!A1:J`, saFile);
    if (!g.ok) return g;
    tGrid = g.data;
    const h = findHeaderRow(tGrid, TRACKER_HEADERS, 10);
    if (!h) return fail('layout', `the tracker header row was not found in the first 10 rows of '${trackerTab.title}' (expected ${TRACKER_HEADERS.join(' | ')})`);
    header = h;
  }
  const status = automationStatus(input.cases);
  const trackerMark = marks.find((m) => m.kind === 'tracker' && m.sheetId === trackerTab.sheetId) ?? null;
  const created = { moduleTab: moduleIsNew, trackerTab: trackerIsNew, section: false, legend: false };
  let trackerRow: number;
  let batch2: SheetRequest[] = [];
  if (trackerMark) {
    trackerRow = trackerMark.row;
  } else {
    const tMerges = mergesOf(trackerTab.sheetId);
    const placement = planTrackerPlacement(tGrid, header, input.module, tMerges, { moduleGid, aliases: cfg.sectionAliases, tab: trackerTab.title });
    if (placement.kind === 'blocked') return fail('layout', placement.why);
    const row = trackerRowRequests({
      sheetId: trackerTab.sheetId, rowCount: trackerTab.rowCount, grid: tGrid, header, placement, merges: tMerges,
      module: input.module, iid, title: input.title, issueUrl: input.issueUrl, status,
      link: { url: deepLink(id, moduleGid, block.a1), text: `${moduleTab.title.trim()} rows ${block.bannerRow + 1}–${block.lastRow + 1}` },
    });
    const legend = planLegend({
      sheetId: trackerTab.sheetId, grid: tGrid, colA: header.cols[TRACKER_HEADERS[0]] ?? 0, rowCount: trackerTab.rowCount,
      placedRow: row.row, inserted: placement.kind !== 'fill',
    });
    trackerRow = row.row;
    created.section = placement.kind === 'new-section';
    created.legend = legend.added !== null;
    batch2 = [...(trackerIsNew ? newTrackerTabRequests(trackerTab.sheetId, trackerTab.title) : []), ...row.requests, ...legend.requests];
  }

  // 5. The two atomic writes: module tab first, because the tracker links into it.
  const w1 = await batchUpdate(id, batch1, saFile, { dryRun: opts.dryRun, tab: moduleTab.title, dryRunSink: opts.dryRunSink });
  if (!w1.ok) return w1;
  const w2 = await batchUpdate(id, batch2, saFile, { dryRun: opts.dryRun, tab: trackerTab.title, dryRunSink: opts.dryRunSink });
  if (!w2.ok) return w2;

  // 6. Read back what is there now; a dry run wrote nothing to read.
  if (!opts.dryRun) {
    const b = await getValues(id, `${quoteTab(moduleTab.title)}!${block.a1}`, saFile);
    if (!b.ok) return b;
    const why = columns ? verifyBlock(b.data, input.cases, iid, columns) : verifyBanner(b.data, iid);
    if (why) return fail('readback', `'${moduleTab.title}' ${block.a1}: ${why}`);
    const t = await getValues(id, `${quoteTab(trackerTab.title)}!A${trackerRow + 1}:J${trackerRow + 1}`, saFile);
    if (!t.ok) return t;
    const whyT = verifyTrackerRow(t.data[0] ?? [], header.cols, iid, status, moduleGid);
    if (whyT) return fail('readback', `'${trackerTab.title}' row ${trackerRow + 1}: ${whyT}`);
  }

  const tCols = Object.values(header.cols);
  const trackerRange = `${a1Col(Math.min(...tCols))}${trackerRow + 1}:${a1Col(Math.max(...tCols))}${trackerRow + 1}`;
  return {
    ok: true,
    data: {
      spreadsheetId: id,
      moduleTab: moduleTab.title, moduleGid, blockRange: block.a1, blockLink: deepLink(id, moduleGid, block.a1),
      trackerTab: trackerTab.title, trackerGid: trackerTab.sheetId, trackerRow: trackerRow + 1,
      trackerLink: deepLink(id, trackerTab.sheetId, trackerRange),
      automationStatus: status,
      created,
      alreadyThere: { block: blockMark !== null, trackerRow: trackerMark !== null },
      dryRun: opts.dryRun,
    },
  };
}
