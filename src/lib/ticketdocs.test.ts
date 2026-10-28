import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  externalDocLinks, isDocument, normalizeLineSeparators, uploadLinks,
} from './ticketdocs.js';

const PROJECT = { url: 'https://gitlab.example.com/acme/erp', id: 42 };
const SECRET = '275920f75d842b9067ea1e8f0a621a45';

test('finds an upload in every shape GitLab writes one', () => {
  const md = [
    `[spec.docx](/uploads/${SECRET}/spec.docx)`,
    `![shot](${PROJECT.url}/uploads/${SECRET}/shot.png)`,
    `[flow](/-/project/42/uploads/${SECRET}/flow.pdf)`,
    `<img src="https://gitlab.example.com/-/project/42/uploads/${SECRET}/ui.png" />`,
  ].join('\n');
  assert.deepEqual(
    uploadLinks(md, 'comment 2', PROJECT).map((l) => l.filename),
    ['spec.docx', 'shot.png', 'flow.pdf', 'ui.png'],
  );
  assert.equal(uploadLinks(md, 'comment 2', PROJECT)[0]!.where, 'comment 2');
});

test("skips another project's upload rather than fetching it with this token", () => {
  const md = [
    `[a](https://gitlab.example.com/acme/other/uploads/${SECRET}/a.pdf)`,
    `[b](/-/project/7/uploads/${SECRET}/b.pdf)`,
    `[c](https://elsewhere.io/uploads/${SECRET}/c.pdf)`,
  ].join('\n');
  assert.deepEqual(uploadLinks(md, 'description', PROJECT), []);
});

test('with no project id to compare against, an id-scoped link is skipped rather than guessed', () => {
  const md = [
    `[spec.docx](/uploads/${SECRET}/spec.docx)`,
    `[flow](/-/project/42/uploads/${SECRET}/flow.pdf)`,
    `<img src="https://gitlab.example.com/-/project/42/uploads/${SECRET}/ui.png" />`,
  ].join('\n');
  assert.deepEqual(
    uploadLinks(md, 'description', { url: PROJECT.url, id: null }).map((l) => l.filename),
    ['spec.docx'],
  );
});

test('the project URL matches whatever its case, since a person typed it', () => {
  const md = `![shot](https://GitLab.example.com/Acme/ERP/uploads/${SECRET}/shot.png)`;
  assert.deepEqual(uploadLinks(md, 'description', PROJECT).map((l) => l.filename), ['shot.png']);
});

test('keeps the filename as linked, so the API path matches what GitLab stored', () => {
  const [l] = uploadLinks(`[x](/uploads/${SECRET}/Payroll%20Rules%20v2.xlsx)`, 'description', PROJECT);
  assert.equal(l!.filename, 'Payroll%20Rules%20v2.xlsx');
  assert.equal(isDocument(l!.filename), true);
});

test('documents and screenshots count; videos and archives do not', () => {
  for (const f of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.csv', 'a.md', 'a.png']) {
    assert.equal(isDocument(f), true, f);
  }
  for (const f of ['a.mp4', 'a.mov', 'a.webm', 'a.zip', 'a']) assert.equal(isDocument(f), false, f);
});

test('external document links: document hosts only, trailing punctuation trimmed', () => {
  const md = 'See https://docs.google.com/document/d/abc/edit. Also '
    + 'https://gitlab.example.com/acme/erp/-/issues/3 and https://acme.sharepoint.com/sites/x/doc.docx';
  assert.deepEqual(externalDocLinks(md, 'comment 1').map((e) => e.url), [
    'https://docs.google.com/document/d/abc/edit',
    'https://acme.sharepoint.com/sites/x/doc.docx',
  ]);
});

/** How many lines Node's readline — the SDK's frame reader — sees in one JSON frame. */
async function framesRead(text: string): Promise<string[]> {
  const frame = JSON.stringify({ type: 'user', text });
  const rl = createInterface({ input: Readable.from([`${frame}\n`]) });
  const lines: string[] = [];
  for await (const line of rl) if (line.trim()) lines.push(line);
  return lines;
}

test('Word line separators become newlines, and nothing else is rewritten', () => {
  assert.equal(normalizeLineSeparators('a\u2028b'), 'a\nb');
  assert.equal(normalizeLineSeparators('a\u2029b'), 'a\nb');
  assert.equal(normalizeLineSeparators('a\u2028\u2028b'), 'a\n\nb');
  const untouched = 'plain\n\ttabbed\r\nwindows — “quoted” • bulleted\u00a0nbsp';
  assert.equal(normalizeLineSeparators(untouched), untouched);
  assert.equal(normalizeLineSeparators(''), '');
});

test('extracted text survives the SDK frame reader as a single parseable line', async () => {
  const withSeparator = `${'a'.repeat(4500)}\u2028${'b'.repeat(50)}`;

  // The bug from the other direction: left in, the frame splits mid-string
  // and the half-frame cannot parse.
  const split = await framesRead(withSeparator);
  assert.equal(split.length, 2);
  assert.throws(() => JSON.parse(split[0]!), /Unterminated string in JSON/);

  const whole = await framesRead(normalizeLineSeparators(withSeparator));
  assert.equal(whole.length, 1);
  assert.equal((JSON.parse(whole[0]!) as { text: string }).text.includes('\u2028'), false);
});
