/**
 * Editing a design request in place: the same comment gets the fresh uploads,
 * and the gate is stamped as showing the new design so it does not re-ask.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { gateSubjectDigest, readJournal, writeJournal, type RunJournal } from '../lib/artifacts.js';
import { runDir } from '../lib/config.js';
import { editGateRequest, type GateAttachment } from './reviewgate.js';

const IID = 999_871;
const design = { applicable: true, screens: [{ id: 'a', mockupHtml: 'design/a.html' }] };
const html: GateAttachment = { name: 'a.html', content: '<html></html>', mime: 'text/html' };

function seed(approval: Record<string, unknown>): void {
  writeJournal({
    runId: 'r-repair', iid: IID, title: 't', url: 'u', createdAt: 1, status: 'running', phases: [],
    designApproval: { requestTs: null, approved: false, feedback: [], ...approval },
  } as unknown as RunJournal);
}

function stubFetch(calls: Array<{ method: string; url: string; body: unknown }>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const data = url.endsWith('/uploads')
      ? { url: '/uploads/abc/a.html', markdown: '[a.html](/uploads/abc/a.html)' }
      : { id: 55 };
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test('the standing request is edited in place with the html, and stamped with the new design', async () => {
  seed({ requestNoteId: 55, requestedDigest: 'old' });
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const restore = stubFetch(calls);
  try {
    const noteId = await editGateRequest({
      iid: IID, gate: 'design', requestBody: 'Oneshot pauses here', subject: design, attachments: [html],
    });
    assert.equal(noteId, 55);
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put?.url.endsWith(`/issues/${IID}/notes/55`), 'edits the same comment');
    assert.match((put?.body as { body: string }).body, /\[a\.html\]\(\/uploads\/abc\/a\.html\)/);
    assert.ok(!calls.some((c) => c.method === 'POST' && c.url.endsWith('/notes')), 'posts no new comment');
    const state = readJournal(IID)?.designApproval;
    assert.equal(state?.requestNoteId, 55);
    assert.equal(state?.requestedDigest, gateSubjectDigest(design));
  } finally {
    restore();
    rmSync(runDir(IID), { recursive: true, force: true });
  }
});

test('nothing is edited without a standing request, or once it is approved', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const restore = stubFetch(calls);
  try {
    seed({ requestNoteId: null });
    assert.equal(await editGateRequest({ iid: IID, gate: 'design', requestBody: 'x', subject: design }), null);
    seed({ requestNoteId: 55, approved: true });
    assert.equal(await editGateRequest({ iid: IID, gate: 'design', requestBody: 'x', subject: design }), null);
    assert.equal(calls.length, 0);
  } finally {
    restore();
    rmSync(runDir(IID), { recursive: true, force: true });
  }
});
