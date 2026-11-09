/**
 * Evidence — the screenshots and videos a run left under state/runs/<iid>/artifacts/,
 * as board rows plus a content-addressed copy in the media dir.
 *
 * Each file lands at <mediaDir>/<run_id>/<sha256>.<ext> as a copy (a reflink where the
 * filesystem has them), so a rescan is idempotent and a re-captured file under the same
 * name becomes a new row. Never a hard link: phases re-capture under the same name and
 * truncate in place (Playwright, ffmpeg -y, TC-01.png every verify lap), which would
 * rewrite the bytes behind every earlier media file and break its sha. The manifests the phases
 * write say what a file IS — a mockup, a before shot, a passing case — and anything
 * no manifest names still ships, untagged, so nothing captured is invisible.
 *
 * Pure apart from the filesystem: no database, no network, and it never throws —
 * a file it cannot ship is named in `skipped` and the rest still go.
 */
import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MEDIA = /\.(png|jpe?g|gif|webm|mp4)$/i;
const VIDEO = /\.(webm|mp4)$/i;
/** Top-level artifact folders that name the phase that wrote them. */
const PHASE_DIRS = new Set(['design', 'demo', 'verify', 'ui-evidence', 'research']);
const CAPTION_MAX = 2000;
/**
 * path → { size, mtimeMs, sha } of files already hashed this process. The collector
 * rescans every 5 s; without this every scan re-reads every video to learn a sha it
 * already shipped.
 */
const hashed = new Map();
/** Files hashed this process — tests read it to prove a scan did no needless reads. */
export const evidenceStats = { hashes: 0 };

/** sha256 of a file in 1 MB chunks: a 100 MB video is never held in memory. */
function hashFile(file) {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  evidenceStats.hashes += 1;
  return h.digest('hex');
}

/** The first `n` bytes of a file (fewer if it is shorter). */
function head(file, n) {
  const buf = Buffer.alloc(n);
  const fd = openSync(file, 'r');
  try { return buf.subarray(0, readSync(fd, buf, 0, n, 0)); } finally { closeSync(fd); }
}

function readJson(...paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }
  return null;
}
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Every regular file under `dir`, artifact-relative with forward slashes. Symlinks are not followed. */
function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** PNG width/height from the IHDR chunk — 24 bytes in, no decoder. */
export function pngSize(buf) {
  const sig = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR';
  return sig ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : { width: null, height: null };
}

/**
 * A ui-evidence shot's tag, from its name and caption. The name is trusted more than
 * the caption: an "after" caption routinely explains what it looked like before.
 */
export function shotTag(file, caption) {
  const name = String(file).toLowerCase();
  const cap = String(caption ?? '').toLowerCase();
  if (/mobile|375|phone/.test(`${name} ${cap}`)) return 'mobile';
  // "Error state: … the list came back empty" is not an empty-state shot.
  if (/empty/.test(name) || /\bempty state\b/.test(cap)) return 'empty';
  if (/before|base-|legacy|v1/.test(name) || /^\s*before\b/.test(cap)) return 'before';
  return 'after';
}

function verifyTag(result) {
  const r = String(result ?? '').toLowerCase();
  if (r === 'pass' || r === 'passed') return 'tc-pass';
  if (r === 'fail' || r === 'failed') return 'tc-fail';
  return null;
}

export function collectEvidence({ runDir, journal, operatorId, mediaDir, maxBytes, seen }) {
  const rows = [];
  const skipped = [];
  const art = join(runDir, 'artifacts');
  if (!journal?.runId || !existsSync(art)) return { rows, skipped };
  const runId = journal.runId;

  const lapOf = (phase) => {
    let lap = 0;
    for (const p of list(journal.phases)) if (p?.phase === phase) lap = Number(p.lap) || 0;
    return lap;
  };
  const manifest = (name) => readJson(join(runDir, name), join(art, name));

  /** artifact-relative path → what the manifests say it is. First mention wins. */
  const refs = new Map();
  const relOf = (p) => {
    const s = str(p);
    if (!s) return null;
    const rel = relative(art, isAbsolute(s) ? resolve(s) : resolve(art, s));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null; // outside artifacts/
    return rel.split(sep).join('/');
  };
  const ref = (p, meta) => {
    const rel = relOf(p);
    if (rel && MEDIA.test(rel) && !refs.has(rel)) refs.set(rel, meta);
  };
  const files = walk(art);

  // design.json — mockups, the before captures they replace, and the prototype walkthrough
  const design = manifest('design.json');
  for (const s of list(design?.screens)) {
    const name = str(s?.name) || str(s?.id) || null;
    ref(s?.screenshot, { phase: 'design', kind: 'mockup', tag: 'mockup', caption: name });
    ref(s?.before, { phase: 'design', kind: 'screenshot', tag: 'before', caption: name ? `${name} (before)` : null });
  }
  // Named whether or not design.json does: a file that is not there is dropped at ship time.
  for (const v of [design?.prototype?.video, 'design/walkthrough.webm', 'design/flow.webm']) {
    ref(v, { phase: 'design', kind: 'video', tag: 'walkthrough', caption: str(design?.summary) || null });
  }

  // ui-evidence.json — the reviewer's screenshot pack
  for (const s of list(manifest('ui-evidence.json')?.screenshots)) {
    ref(s?.file, { phase: 'ui-evidence', kind: 'screenshot', tag: shotTag(s?.file, s?.caption), caption: str(s?.caption) || str(s?.file) });
  }

  // demo.json — `webm` is a bare name under artifacts/demo/
  const demo = manifest('demo.json');
  const webm = str(demo?.webm);
  if (webm) {
    ref(isAbsolute(webm) || webm.includes('/') ? webm : `demo/${webm}`, {
      phase: 'demo', kind: 'video', tag: 'walkthrough',
      caption: str(demo?.journey) || str(demo?.title) || str(demo?.summary) || null,
    });
  }

  // verify.json — one screenshot per executed case
  for (const r of list(manifest('verify.json')?.results)) {
    ref(r?.screenshot, { phase: 'verify', kind: 'screenshot', tag: verifyTag(r?.result), caption: `${str(r?.id)} ${str(r?.result)}`.trim() || null });
  }

  // research — repro-<n>.png, captioned by the reproduction evidence line that names it
  const evidenceLines = list(manifest('research.json')?.reproduction?.evidence).map(str);
  for (const f of files) {
    const base = f.split('/').pop();
    if (!/^repro-.*\.png$/i.test(base)) continue;
    ref(f, { phase: 'research', kind: 'screenshot', tag: 'repro', caption: evidenceLines.find((l) => l.includes(base)) || base });
  }

  // Fallback: media nobody named still ships, untagged.
  for (const f of files) {
    if (refs.has(f) || !/\.(png|gif|webm|mp4)$/i.test(f)) continue;
    const top = f.includes('/') ? f.split('/')[0] : '';
    refs.set(f, {
      phase: PHASE_DIRS.has(top) ? top : 'ui-evidence',
      kind: VIDEO.test(f) ? 'video' : 'screenshot', tag: null, caption: f.split('/').pop(),
    });
  }

  if (!refs.size) return { rows, skipped };
  // One check up front: a media dir nobody can write to must not cost a hash of
  // every file every scan, nor one skip line per file.
  try {
    mkdirSync(mediaDir, { recursive: true });
    accessSync(mediaDir, constants.W_OK);
  } catch (e) {
    return { rows, skipped: [`${mediaDir}: not writable (${e.code ?? e.message})`] };
  }

  const emitted = new Set();
  const runMedia = join(mediaDir, runId);
  let mediaReady = false;
  for (const [rel, meta] of refs) {
    const src = join(art, rel);
    let st;
    try {
      st = lstatSync(src); // a symlink could point outside artifacts/
      if (!st.isFile()) continue;
      if (st.size > maxBytes) { skipped.push(`${rel}: ${st.size} bytes, over ${maxBytes} bytes`); continue; }
    } catch (e) {
      if (e.code !== 'ENOENT') skipped.push(`${rel}: unreadable (${e.code ?? e.message})`);
      continue; // a manifest naming a file that was never written is not evidence
    }
    // Unchanged since it was last hashed: reuse the sha, so even a file whose copy failed is not re-read.
    const known = hashed.get(src);
    let sha = known && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.sha : null;
    if (!sha) {
      try { sha = hashFile(src); } catch (e) { skipped.push(`${rel}: unreadable (${e.code ?? e.message})`); continue; }
      hashed.set(src, { size: st.size, mtimeMs: st.mtimeMs, sha });
    }
    if (seen?.has(sha) || emitted.has(sha)) continue;

    const ext = (extname(rel).slice(1) || 'bin').toLowerCase();
    const dst = join(runMedia, `${sha}.${ext}`);
    const tmp = join(runMedia, `.${sha}.${ext}.tmp`);
    try {
      if (!mediaReady) { mkdirSync(runMedia, { recursive: true }); mediaReady = true; }
      let have = null;
      try { have = statSync(dst).size; } catch { /* not there yet */ }
      // Same sha and same size: already copied. A different size is a torn earlier copy;
      // tmp + rename replaces it, and a reader never sees a half-written file.
      if (have !== st.size) {
        copyFileSync(src, tmp, constants.COPYFILE_FICLONE);
        renameSync(tmp, dst);
      }
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      skipped.push(`${rel}: media dir not writable (${e.code ?? e.message})`);
      continue;
    }

    emitted.add(sha);
    let dims = { width: null, height: null };
    if (/\.png$/i.test(rel)) { try { dims = pngSize(head(dst, 24)); } catch { /* copied already; size unknown */ } }
    rows.push({
      id: sha, run_id: runId, ticket_iid: journal.iid, phase: meta.phase, lap: lapOf(meta.phase),
      kind: meta.kind, tag: meta.tag, caption: meta.caption ? meta.caption.slice(0, CAPTION_MAX) : null,
      source_path: rel, path: `${runId}/${sha}.${ext}`, bytes: st.size,
      width: dims.width, height: dims.height, duration_ms: null, operator_id: operatorId,
    });
  }
  return { rows, skipped };
}
