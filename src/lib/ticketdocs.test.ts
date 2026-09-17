import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalDocLinks, isDocument, uploadLinks } from './ticketdocs.js';

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
