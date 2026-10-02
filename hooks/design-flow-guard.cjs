#!/usr/bin/env node
'use strict';
/**
 * PreToolUse on `StructuredOutput`: a `design` that changes a flow does not end
 * until the clickable prototype and the walkthrough video it owes are on disk.
 *
 * WHY A HOOK. The phase's final answer IS a tool call — the SDK's json_schema
 * output arrives as `StructuredOutput`, and PreToolUse sees it like any other
 * tool. A deny goes back to the session as the tool's error and the session
 * calls it again with what it fixed (verified against SDK 0.1.77: the second
 * call's input is what `structured_output` carries). That is the one place a
 * missing deliverable can still be made by the session that skipped it. The
 * conductor's own check (`designDeliverableRefusal`) runs after the session is
 * dead, so all it can do is fail the phase and pay for a second one.
 *
 * A PostToolUse block does NOT work here: the output is accepted with
 * "provided successfully" before the hook's reason arrives.
 *
 * WHAT IT ASKS FOR, when `applicable` and `flowChange` are true, or whenever a
 * `prototype` is reported at all (whatever is reported gets posted):
 *   - `prototype.entry`: an HTML file in the artifact directory that a
 *     reviewer can download from the ticket ALONE and click through. So every
 *     resource it loads is inline (`data:`), it never links to a sibling file,
 *     and it has something to click (a script or a `#` link).
 *   - `prototype.video`: a real recording — `.webm` or `.mp4` by its magic
 *     bytes, larger than an empty recording, and small enough that the gate's
 *     upload does not silently drop it.
 *
 * GIVES UP after MAX_REFUSALS in one session and lets the output through,
 * logged. A guard that refuses forever turns an environment that cannot record
 * (no ffmpeg, a dead browser) into a session that burns its whole turn cap
 * calling StructuredOutput. Released, the output meets the conductor's check,
 * which fails the phase with a reason a person can act on.
 *
 * FAILS OPEN on its own errors, like every guard here.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const PHASE = 'design';

/**
 * Playwright's recording of a page that closes at once is ~3 KB; three seconds
 * of a static mockup is ~150 KB at 1280x800. Anything under this never
 * recorded a walkthrough.
 */
const MIN_VIDEO_BYTES = 32 * 1024;

/** src/lib/publish.ts MAX_UPLOAD_BYTES — over it, the gate drops the file with a log line. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MAX_REFUSALS = 3;

const VIDEO_MAGIC = {
  '.webm': (b) => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3,
  '.mp4': (b) => b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp',
};

const RECIPE =
  'How: build ONE self-contained HTML file (tokens.css pasted into a <style>, every image a data: URI, '
  + 'hash routing in vanilla JS, one state per screen in journey order), then record it with Playwright — '
  + "`browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } })`, "
  + 'drive the happy path with an annotation overlay before each click, and `await context.close()` '
  + 'BEFORE you read `page.video().path()`: the file is only finished on close. Move it to the name you report. '
  + 'Both files go in the artifact directory, then call StructuredOutput again.';

function artifactDir() {
  return path.join(C.STATE, 'runs', C.ticket(), 'artifacts');
}

/** An artifact-relative path, or null when it is empty, absolute, or climbs out. */
function resolveArtifact(rel) {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return null;
  const dir = artifactDir();
  const full = path.resolve(dir, rel);
  return C.isInside(full, dir) ? full : null;
}

function statFile(full) {
  try {
    const st = fs.statSync(full);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** A value the browser fetches from somewhere else, as opposed to inline or in-page. */
function isExternal(value) {
  const v = value.trim();
  if (!v || v.includes('${') || v.includes('{{')) return false;
  return !/^(data:|#|about:blank)/i.test(v);
}

/**
 * Everything the prototype LOADS that only exists next to the files it was
 * built beside: a `src` on any tag, a `<link href>`, and a CSS `@import` or
 * `url()`. Downloaded alone from the ticket, each one renders as a hole.
 *
 * Anchors are left alone — a nav link copied from the real shell dead-ends,
 * but the page still renders. Script bodies are skipped, so `new URL(...)` and
 * markup built in strings are not mistaken for references.
 */
function brokenReferences(html) {
  const found = new Set();
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  const attr = /<(\w+)\b[^>]*?(?<![\w:-])(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of markup.matchAll(attr)) {
    const tag = m[1].toLowerCase();
    const name = m[2].toLowerCase();
    if (name === 'href' && tag !== 'link') continue;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (isExternal(value)) found.add(`<${tag} ${name}="${value}">`);
  }
  const css = [
    ...[...markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
    ...[...markup.matchAll(/(?<![\w-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]),
  ].join('\n');
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
    if (isExternal(m[1])) found.add(`@import ${m[1]}`);
  }
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) {
    if (isExternal(m[1])) found.add(`url(${m[1]})`);
  }
  return [...found];
}

function prototypeProblems(entry) {
  const full = resolveArtifact(entry);
  if (!full) return [`prototype.entry "${entry || ''}" is not a path inside the artifact directory`];
  if (!/\.html?$/i.test(full)) return [`prototype.entry "${entry}" is not an .html file`];
  if (!statFile(full)) return [`prototype.entry "${entry}" is not on disk at ${full}`];
  const html = fs.readFileSync(full, 'utf8');
  const problems = [];
  if (!/<(html|body)\b/i.test(html)) problems.push(`prototype.entry "${entry}" is not an HTML document`);
  if (!/<script\b/i.test(html) && !/href\s*=\s*["']?#/i.test(html)) {
    problems.push(`prototype.entry "${entry}" has nothing to click — no script and no # links between its states`);
  }
  const broken = brokenReferences(html);
  if (broken.length) {
    problems.push(
      `prototype.entry "${entry}" loads files it will not have once a reviewer downloads it from the ticket: `
      + `${broken.slice(0, 6).join(', ')}${broken.length > 6 ? `, and ${broken.length - 6} more` : ''}. Inline them`,
    );
  }
  return problems;
}

function videoProblems(video) {
  const full = resolveArtifact(video);
  if (!full) return [`prototype.video "${video || ''}" is not a path inside the artifact directory`];
  const ext = path.extname(full).toLowerCase();
  const magic = VIDEO_MAGIC[ext];
  if (!magic) return [`prototype.video "${video}" is not a .webm or .mp4`];
  const st = statFile(full);
  if (!st) return [`prototype.video "${video}" is not on disk at ${full}`];
  if (st.size > MAX_UPLOAD_BYTES) {
    return [`prototype.video "${video}" is ${st.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte upload limit, so it would never reach the ticket — keep it under 60 seconds`];
  }
  const head = Buffer.alloc(8);
  const fd = fs.openSync(full, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!magic(head)) return [`prototype.video "${video}" is not a real ${ext} file`];
  if (st.size < MIN_VIDEO_BYTES) {
    return [`prototype.video "${video}" is ${st.size} bytes — an empty recording, not a walkthrough. Was the context closed before the page was driven?`];
  }
  return [];
}

function problemsWith(design) {
  if (!design || typeof design !== 'object' || design.applicable === false) return [];
  const proto = design.prototype && typeof design.prototype === 'object' ? design.prototype : null;
  if (!proto) {
    return design.flowChange === true
      ? ['flowChange is true but prototype is null — a flow change owes the reviewer a clickable prototype and a walkthrough video']
      : [];
  }
  return [...prototypeProblems(proto.entry), ...videoProblems(proto.video)];
}

function counterFile(session) {
  return path.join(C.STATE, 'hook-state', 'design-flow-guard', `${String(session).replace(/[^\w-]/g, '_')}.count`);
}

/** Refusals already given to this session, counting this one. */
function countRefusal(session) {
  if (!session) return 1;
  const file = counterFile(session);
  let n = 0;
  try { n = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { n = 0; }
  n += 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(n));
  } catch (err) { C.logFailure('design-flow-guard', err); }
  return n;
}

try {
  if (C.phase() !== PHASE) C.allow();
  const input = C.readInput();
  if (input.tool_name !== 'StructuredOutput') C.allow();

  const problems = problemsWith(input.tool_input);
  if (problems.length === 0) {
    if (input.tool_input?.flowChange === true) C.event('design_flow_ok', { prototype: input.tool_input.prototype });
    C.allow();
  }

  const n = countRefusal(input.session_id);
  if (n > MAX_REFUSALS) {
    C.event('design_flow_released', { refusals: n - 1, problems });
    C.allow();
  }
  C.event('design_flow_refused', { attempt: n, problems });
  C.deny(
    `Not finished — this design changes a flow, and the reviewer gets the flow as a clickable prototype `
    + `and a walkthrough video, not only as stills (refusal ${n} of ${MAX_REFUSALS}):\n`
    + `${problems.map((p) => `  - ${p}`).join('\n')}\n\n${RECIPE}`,
  );
} catch (err) {
  C.logFailure('design-flow-guard', err);
  C.allow();
}
