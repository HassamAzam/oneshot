/**
 * The documents a ticket points at, made readable before `research` starts.
 *
 * A ticket's requirements do not all live in its text. A spec is attached as a
 * .docx, the expected figures as an .xlsx, the flow as a PDF — and a markdown
 * link to `/uploads/…` is all a phase sees of them. The upload sits behind the
 * project's auth, so a session cannot simply fetch it, and it would have to
 * choose to. So the conductor does it: every document attached in the
 * description or a comment is downloaded into the run dir, turned into text
 * where the Read tool cannot open the format itself, and listed in the prompt
 * by local path.
 *
 * Videos are deliberately left out — a phase cannot watch one, and downloading
 * hundreds of megabytes to list a path nobody can read is pure cost.
 *
 * Best effort throughout. A document that fails to download or convert is still
 * listed, with the reason, so the phase can name it as an unknown rather than
 * never learning it existed. Nothing here fails a run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { projectConfig, runDir } from './config.js';
import { downloadUpload } from './gitlab.js';
import { log } from './log.js';
import type { TicketDoc } from '../phases/types.js';

/** Opened directly by the Read tool. Images count: a screenshot is ticket context. */
const READABLE = new Set([
  '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
]);
/** Need a text extraction first. */
const CONVERTIBLE = new Set(['.docx', '.doc', '.rtf', '.odt', '.xlsx', '.xlsm', '.pptx']);

const MAX_DOCS = 40;
const MAX_BYTES = 25 * 1024 * 1024;

export interface UploadLink { secret: string; filename: string; where: string }

/**
 * Upload links to THIS project's files, in any of the shapes GitLab writes
 * them: `/uploads/<secret>/<file>`, the same under `/-/project/<id>/`, or
 * either prefixed with the host. A full URL to another project's upload is
 * skipped — this token has no business there and the API path would be wrong.
 */
export function uploadLinks(
  markdown: string, where: string, project: { url: string; id: number },
): UploadLink[] {
  const out: UploadLink[] = [];
  const re = /(https?:\/\/[^\s)"'<>\]]*?)?(?:\/-\/project\/(\d+))?\/uploads\/([0-9a-f]{16,64})\/([^\s)"'<>?#\]]+)/gi;
  for (const m of markdown.matchAll(re)) {
    const [, prefix, pid, secret, filename] = m;
    if (pid && Number(pid) !== project.id) continue;
    if (prefix && !pid && prefix.replace(/\/-$/, '') !== project.url) continue;
    if (prefix && pid && !project.url.startsWith(prefix)) continue;
    out.push({ secret: secret!, filename: filename!, where });
  }
  return out;
}

/** Hosts whose links are documents, not code or tickets. */
const DOC_HOSTS = /^https?:\/\/(docs\.google\.com|drive\.google\.com|[\w-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms|[\w-]+\.atlassian\.net\/wiki|(?:www\.)?notion\.so|[\w-]+\.notion\.site|(?:www\.)?dropbox\.com|paper\.dropbox\.com)\//i;

export function externalDocLinks(markdown: string, where: string): Array<{ url: string; where: string }> {
  const out: Array<{ url: string; where: string }> = [];
  for (const m of markdown.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    if (DOC_HOSTS.test(m[0])) out.push({ url: m[0].replace(/[.,;:]+$/, ''), where });
  }
  return out;
}

export function isDocument(filename: string): boolean {
  const ext = extname(safeName(filename)).toLowerCase();
  return READABLE.has(ext) || CONVERTIBLE.has(ext);
}

function safeName(filename: string): string {
  let name = filename;
  try { name = decodeURIComponent(filename); } catch { /* keep it encoded */ }
  return name.replace(/[/\\]/g, '_').replace(/^\.+/, '_') || 'file';
}

/** Python one-liners, because openpyxl and zipfile are on every desk and nothing Node-native is. */
const XLSX_TO_TEXT = `
import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
for ws in wb.worksheets:
    print(f"=== sheet: {ws.title} ===")
    for row in ws.iter_rows(values_only=True):
        if any(c is not None for c in row):
            print("\\t".join("" if c is None else str(c) for c in row))
`;
const PPTX_TO_TEXT = `
import sys, re, zipfile
z = zipfile.ZipFile(sys.argv[1])
slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\\d+\\.xml$", n)),
                key=lambda n: int(re.findall(r"\\d+", n)[0]))
for i, n in enumerate(slides, 1):
    print(f"=== slide {i} ===")
    print("\\n".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(n).decode("utf8"))))
`;

function toText(src: string, ext: string): string {
  const run = (cmd: string, args: string[]): string =>
    execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (ext === '.xlsx' || ext === '.xlsm') return run('python3', ['-c', XLSX_TO_TEXT, src]);
  if (ext === '.pptx') return run('python3', ['-c', PPTX_TO_TEXT, src]);
  // .docx .doc .rtf .odt — macOS's textutil reads all four.
  return run('textutil', ['-convert', 'txt', '-stdout', src]);
}

/**
 * Download and convert every document the ticket's text links to. Cached by
 * upload secret in the run dir, so the per-tick re-read of a `--follow` or
 * parked run costs one existence check per document, not a download.
 */
export async function collectTicketDocs(
  iid: number, sources: Array<{ where: string; body: string }>,
): Promise<{ documents: TicketDoc[]; externalDocs: Array<{ url: string; where: string }> }> {
  const c = projectConfig();
  const project = { url: `https://${c.gitlab.host}/${c.gitlab.project}`, id: c.gitlab.projectId };

  const seen = new Set<string>();
  const links: UploadLink[] = [];
  const externalDocs: Array<{ url: string; where: string }> = [];
  const seenExternal = new Set<string>();
  for (const s of sources) {
    for (const l of uploadLinks(s.body, s.where, project)) {
      const key = `${l.secret}/${l.filename}`;
      if (seen.has(key) || !isDocument(l.filename)) continue;
      seen.add(key);
      links.push(l);
    }
    for (const e of externalDocLinks(s.body, s.where)) {
      if (seenExternal.has(e.url)) continue;
      seenExternal.add(e.url);
      externalDocs.push(e);
    }
  }
  if (links.length > MAX_DOCS) {
    log.warn(`#${iid}: ${links.length} attached documents; reading the first ${MAX_DOCS}`);
  }

  const documents: TicketDoc[] = [];
  for (const l of links.slice(0, MAX_DOCS)) {
    const name = safeName(l.filename);
    const ext = extname(name).toLowerCase();
    const dir = join(runDir(iid), 'ticket-docs', l.secret);
    const path = join(dir, name);
    const doc: TicketDoc = { name, where: l.where };
    documents.push(doc);

    if (!existsSync(path) || statSync(path).size === 0) {
      const res = await downloadUpload(l.secret, l.filename);
      if (!res.ok || !res.data) {
        doc.error = `download failed (${res.kind} ${res.status})`;
        continue;
      }
      if (res.data.length > MAX_BYTES) {
        doc.error = `too large to read (${Math.round(res.data.length / 1024 / 1024)} MB)`;
        continue;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, res.data);
    }
    doc.path = path;

    if (CONVERTIBLE.has(ext)) {
      const textPath = `${path}.txt`;
      try {
        if (!existsSync(textPath)) writeFileSync(textPath, toText(path, ext));
        doc.textPath = textPath;
      } catch (err) {
        doc.error = `could not extract text: ${((err as Error).message.split('\n')[0] ?? '').slice(0, 160)}`;
      }
    }
  }

  const failed = documents.filter((d) => d.error).length;
  if (documents.length || externalDocs.length) {
    log.info(`#${iid}: ticket documents`, {
      attached: documents.length, unreadable: failed, external: externalDocs.length,
    });
  }
  return { documents, externalDocs };
}
