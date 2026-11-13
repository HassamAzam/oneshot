/**
 * Keep a ticket's Google Drive folder in step with its run directory.
 *
 * Same shape as `publish.ts`, for the same reasons: it is code, not a phase,
 * and it RECONCILES. Each pass maps the run's artifacts to the files the folder
 * should hold (`drivepack.ts`), hashes each one, and uploads only what is new
 * or changed since the hash recorded in `journal.drive`. A later lap that
 * rewrites the plan replaces the plan Doc in place (Drive keeps the old one as
 * a revision); a pass with nothing new makes no Drive call past the folder
 * lookup it has already cached.
 *
 * Identity lives in Drive, not only in the journal: the ticket folder carries
 * `appProperties.oneshotTicket = <project>:<iid>` and each file `oneshotKey`.
 * A ticket's second run starts with a fresh journal (`archiveRun` moves the
 * first aside) and still finds the same folder and the same files, so a re-run
 * never duplicates.
 *
 * Off unless both ONESHOT_GDRIVE_ROOT and ONESHOT_GDRIVE_CREDENTIALS are set,
 * and never throws: Drive is a shelf for people to browse, so a refused upload
 * is logged and the run carries on.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DRY_RUN, PROJECT_TARGET, artifactDir, envOr, expandPath, handoffAtMerge } from './config.js';
import { readArtifact, readJournal, updateJournal, type RunJournal } from './artifacts.js';
import { Drive, DriveError } from './gdrive.js';
import {
  GOOGLE_SHEET, INDEX_HEADER, INDEX_NAME, SHOTS_FOLDER, demoPdfHtml, findIndexRow, indexRow, packEntries, sameRow,
  ticketFolderName,
  type DemoMeta, type DriveEntry, type PackInput, type Shot,
} from './drivepack.js';
import { renderPlanMd, renderTestcasesCsv } from './publish.js';
import { log } from './log.js';

export interface DriveLedger {
  folderId?: string;
  folderName?: string;
  folderUrl?: string;
  shotsFolderId?: string;
  /** Per entry key: the Drive file id and the hash of what was last uploaded. */
  files: Record<string, { id: string; hash: string }>;
}

export function driveConfig(): { root: string; credentials: string } | null {
  const root = envOr('ONESHOT_GDRIVE_ROOT').trim();
  const cred = envOr('ONESHOT_GDRIVE_CREDENTIALS').trim();
  if (!root || !cred) return null;
  return { root, credentials: expandPath(cred) };
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The UI-evidence screenshots that exist on disk, in the order the phase listed them. */
function shotsOf(iid: number, ui: Record<string, unknown> | null): Shot[] {
  const dir = artifactDir(iid);
  const rows = Array.isArray(ui?.screenshots) ? ui!.screenshots as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const out: Shot[] = [];
  for (const r of rows) {
    const file = String(r.file ?? '').trim();
    // A bare name only: the folder must never be fed a path from outside the run.
    if (!file || file.includes('/') || file.includes('..') || seen.has(file)) continue;
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    seen.add(file);
    out.push({ file, path, caption: String(r.caption ?? '').trim(), caseId: String(r.caseId ?? '').trim() || undefined });
  }
  return out;
}

/** demo.json's recording, or — for runs that predate demo.json — the one video in artifacts/demo/. */
function demoVideoOf(iid: number, demo: Record<string, unknown> | null): string | null {
  const dir = join(artifactDir(iid), 'demo');
  const named = String(demo?.webm ?? '').trim();
  if (named && !named.includes('/') && existsSync(join(dir, named))) return join(dir, named);
  if (demo || !existsSync(dir)) return null;
  const vids = readdirSync(dir).filter((f) => /\.(webm|mp4)$/i.test(f)).sort();
  return vids.length === 1 ? join(dir, vids[0]!) : null;
}

export function packInputFor(j: RunJournal): PackInput {
  const iid = j.iid;
  const plan = readArtifact<Record<string, unknown>>(iid, 'plan.json');
  const tc = readArtifact<{ cases?: unknown[] }>(iid, 'testcases.json');
  const ui = readArtifact<Record<string, unknown>>(iid, 'ui-evidence.json');
  return {
    iid,
    title: j.title,
    issueUrl: j.url,
    status: j.status,
    stoppedPhase: j.stoppedPhase,
    blockedWhy: j.blockedWhy,
    branch: j.branch,
    mrUrl: j.mrUrl,
    mrIid: j.mrIid,
    mergedSha: j.mergedSha,
    phases: j.phases ?? [],
    research: readArtifact(iid, 'research.json'),
    plan: plan ? renderPlanMd(iid, j.title, plan as never, j.baseSha) : null,
    testcasesCsv: tc?.cases?.length ? renderTestcasesCsv(tc.cases as never) : null,
    verify: readArtifact(iid, 'verify.json'),
    findings: readArtifact(iid, 'findings.json'),
    shots: shotsOf(iid, ui),
    evidenceSummary: typeof ui?.summary === 'string' ? ui.summary : undefined,
    demoVideo: demoVideoOf(iid, readArtifact(iid, 'demo.json')),
  };
}

function hashOf(e: DriveEntry): string {
  const s = e.source;
  if (s.kind === 'text') return sha(s.text);
  if (s.kind === 'file') return sha(readFileSync(s.path));
  return sha(JSON.stringify({
    meta: s.meta,
    shots: s.shots.map((x) => [x.file, x.caption, x.caseId ?? '', sha(readFileSync(x.path))]),
  }));
}

/** Render the screenshot demo to PDF in a headless browser. Null on any failure — the pass carries on. */
async function buildPdf(meta: DemoMeta, shots: Shot[]): Promise<Buffer | null> {
  let browser: { close(): Promise<void> } | null = null;
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch();
    browser = b;
    const page = await b.newPage();
    const html = demoPdfHtml(meta, shots.map((s) => ({
      src: `data:${s.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(s.path).toString('base64')}`,
      caption: s.caption, file: s.file, caseId: s.caseId,
    })));
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } catch (err) {
    log.warn('drive: demo PDF not built', { error: (err as Error).message.slice(0, 160) });
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function bytesOf(e: DriveEntry): Promise<Buffer | null> {
  const s = e.source;
  if (s.kind === 'text') return Buffer.from(s.text, 'utf8');
  if (s.kind === 'file') return readFileSync(s.path);
  return buildPdf(s.meta, s.shots);
}

async function ensureFolder(
  drive: Drive, parent: string, cachedId: string | undefined, key: string, value: string, name: string, description?: string,
): Promise<{ id: string; url?: string; created: boolean }> {
  if (cachedId) return { id: cachedId, created: false };
  const found = await drive.findByProperty(parent, key, value);
  if (found) return { id: found.id, url: found.webViewLink, created: false };
  const made = await drive.createFolder(parent, name, { [key]: value }, description);
  return { id: made.id, url: made.webViewLink, created: true };
}

/** The index spreadsheet's id, once found or made — it lives at the root, not in any one journal. */
let indexId: string | undefined;

/** Column letter of the index's last column (12 columns → L). */
const LAST_COL = String.fromCharCode(64 + INDEX_HEADER.length);

/**
 * Upsert ticket `j`'s row in the root's index spreadsheet. The sheet is made by
 * this app (a Drive upload converted to a Sheet), which is what keeps it inside
 * the `drive.file` scope. A row that already says the same thing is not
 * rewritten, so a quiet pass reads two ranges and writes nothing.
 */
async function updateIndex(drive: Drive, root: string, j: RunJournal, ledger: DriveLedger): Promise<void> {
  if (!indexId) {
    const found = await drive.findByProperty(root, 'oneshotKey', 'ticket-index');
    indexId = found?.id ?? (await drive.upload({
      parent: root, name: INDEX_NAME, mime: 'text/csv', convertTo: GOOGLE_SHEET,
      props: { oneshotKey: 'ticket-index' }, content: Buffer.from(`${INDEX_HEADER.join(',')}\n`),
    })).id;
  }
  const row = indexRow({
    iid: j.iid, title: j.title, issueUrl: j.url, status: j.status, mergedSha: j.mergedSha,
    stoppedPhase: j.stoppedPhase, phases: j.phases ?? [], createdAt: j.createdAt, stoppedAt: j.stoppedAt,
    mrUrl: j.mrUrl, folderUrl: ledger.folderUrl, files: ledger.files,
  });
  const colA = (await drive.sheetRead(indexId, 'A:A')).map((r) => r[0] ?? '');
  const at = findIndexRow(colA, j.url);
  if (at === null) {
    await drive.sheetAppend(indexId, `A:${LAST_COL}`, [row]);
    return;
  }
  const range = `A${at}:${LAST_COL}${at}`;
  if (sameRow((await drive.sheetRead(indexId, range))[0], row)) return;
  await drive.sheetWrite(indexId, range, [row]);
}

/** Consecutive upload failures after which a pass gives up — a bad credential fails every call alike. */
const GIVE_UP_AFTER = 3;

/**
 * Whether a pass may write the ticket's folder now. On a conductor that hands
 * runs off at merge (ONESHOT_HANDOFF_AT_MERGE) the folder is filled once, from
 * the finished run, when it is handed off — not built up phase by phase out of
 * work a later lap may still replace.
 */
export function driveSyncDue(j: Pick<RunJournal, 'handedOff'>): boolean {
  return !handoffAtMerge() || j.handedOff === true;
}

/**
 * Bring ticket `iid`'s Drive folder up to date with its run directory.
 * Never throws; returns the folder URL when it has one (for the CLI and logs).
 */
export async function syncDrive(iid: number): Promise<string | null> {
  const cfg = driveConfig();
  if (!cfg) return null;
  if (DRY_RUN) return null;
  const j = readJournal(iid);
  if (!j) return null;
  if (!driveSyncDue(j)) return null;
  const ledger: DriveLedger = { files: {}, ...(j.drive ?? {}) };
  const save = (): void => { updateJournal(iid, { drive: ledger }); };
  try {
    if (!existsSync(cfg.credentials) || !statSync(cfg.credentials).isFile()) {
      log.warn('drive: ONESHOT_GDRIVE_CREDENTIALS does not name a readable file — skipping');
      return null;
    }
    const drive = new Drive(cfg.credentials);
    const name = ticketFolderName(iid, j.title);
    const project = j.project ?? PROJECT_TARGET;
    const folder = await ensureFolder(drive, cfg.root, ledger.folderId, 'oneshotTicket', `${project}:${iid}`, name, j.url);
    if (!ledger.folderId) {
      ledger.folderId = folder.id;
      ledger.folderUrl = folder.url ?? (await drive.get(folder.id)).webViewLink;
      ledger.folderName = name;
      save();
      if (folder.created) log.ok(`drive: folder for #${iid} → ${ledger.folderUrl}`);
    } else if (ledger.folderName !== name) {
      await drive.patchMeta(ledger.folderId, { name, description: j.url });
      ledger.folderName = name;
      save();
    }

    let failures = 0;
    let uploaded = 0;
    for (const e of packEntries(packInputFor(j))) {
      if (failures >= GIVE_UP_AFTER) break;
      try {
        const hash = hashOf(e);
        const prev = ledger.files[e.key];
        if (prev?.hash === hash) continue;
        const content = await bytesOf(e);
        if (!content) continue;
        let parent = ledger.folderId!;
        if (e.inShots) {
          const shots = await ensureFolder(drive, parent, ledger.shotsFolderId, 'oneshotKey', 'shots', SHOTS_FOLDER);
          if (ledger.shotsFolderId !== shots.id) { ledger.shotsFolderId = shots.id; save(); }
          parent = shots.id;
        }
        const id = prev?.id ?? (await drive.findByProperty(parent, 'oneshotKey', e.key))?.id;
        const opts = { parent, name: e.name, mime: e.mime, convertTo: e.convertTo, props: { oneshotKey: e.key }, content };
        let file;
        try {
          file = await drive.upload({ ...opts, id });
        } catch (err) {
          // Someone deleted the file by hand: recreate it rather than fail forever on a dead id.
          if (!(id && err instanceof DriveError && err.status === 404)) throw err;
          file = await drive.upload(opts);
        }
        ledger.files[e.key] = { id: file.id, hash };
        save();
        uploaded += 1;
        failures = 0;
      } catch (err) {
        failures += 1;
        log.warn(`drive: ${e.key} not uploaded`, { iid, error: (err as Error).message.slice(0, 200) });
      }
    }
    if (uploaded) log.ok(`drive: #${iid} — ${uploaded} file(s) updated`, { folder: ledger.folderUrl });
    // Its own try: a Sheets refusal (the API not enabled on the client's
    // project, say) must not read as the folder having failed.
    try {
      await updateIndex(drive, cfg.root, j, ledger);
    } catch (err) {
      // Deleted by hand: forget it, and the next pass finds or makes another.
      if (err instanceof DriveError && err.status === 404) indexId = undefined;
      log.warn('drive: ticket index not updated', { iid, error: (err as Error).message.slice(0, 200) });
    }
    return ledger.folderUrl ?? null;
  } catch (err) {
    log.warn('drive: sync pass failed', { iid, error: (err as Error).message.slice(0, 200) });
    return ledger.folderUrl ?? null;
  }
}
