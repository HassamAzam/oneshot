/**
 * The browser harness's bring-up preconditions.
 *
 * Lives under src/ because that is the only tree `npm test` globs, while the
 * harness itself ships inside the skill that uses it. It is reached through
 * the API that skill already exports for scripts/app.cjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './config.js';

const require = createRequire(import.meta.url);
const harness = require(
  join(ROOT, 'skills/local-browser-verify/scripts/harness.cjs'),
) as {
  applyPatches: (wt: string, bePort: number, fePort: number) => { apiUrl: boolean };
  needsCollectstatic: (wt: string) => boolean;
  disabledIntegrations: (wt: string) => Array<{ name: string; why: string }>;
  waitDjango: (port: number, pid: number, budgetMs: number) => Promise<boolean>;
};

/**
 * The template the app repo commits at its root, trimmed to the keys these tests
 * reason about. The real one carries 27 exports; what matters here is that it holds
 * keys a developer's seeded copy can be missing.
 */
const TEMPLATE = [
  "export const apiUrl = 'http://localhost:8000/';",
  "export const googleApiClientId = 'googleApiClientId';",
  'export const USE_CALENDAR_API = false;',
  "export const SENTRY_DSN = '';",
  "export const HOTJAR_SITE_ID = '';",
].join('\n');

/** A worktree with the files applyPatches touches. `config` omitted = no seed copy. */
function seeded(config?: string, template: string | null = TEMPLATE): string {
  const wt = mkdtempSync(join(tmpdir(), 'harness-patch-'));
  mkdirSync(join(wt, 'frontend/config'), { recursive: true });
  mkdirSync(join(wt, 'frontend/src/constants'), { recursive: true });
  writeFileSync(
    join(wt, 'frontend/config/localPaths.js'),
    "const LOCAL_PUBLIC_URL = 'http://localhost:3000';\n",
  );
  if (template !== null) writeFileSync(join(wt, 'config.example.js'), `${template}\n`);
  if (config !== undefined) {
    writeFileSync(join(wt, 'frontend/src/constants/config.js'), `${config}\n`);
  }
  return wt;
}

const configOf = (wt: string): string =>
  readFileSync(join(wt, 'frontend/src/constants/config.js'), 'utf8');
const exportsOf = (wt: string): string[] =>
  [...configOf(wt).matchAll(/^export const (\w+)/gm)]
    .map((m) => m[1])
    .filter((k): k is string => Boolean(k));

/* --------------------------------------------------------------- config.js */

test('a key the seed is missing is supplied by the template', () => {
  // The whole point. A seed without SENTRY_DSN compiled fine on apiUrl and then
  // broke frontend/src/sentryConfig.js, which imports it by name — webpack failed
  // and the app never rendered, while apiUrl was perfectly correct.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';");
  harness.applyPatches(wt, 8001, 3001);
  assert.ok(configOf(wt).includes("export const SENTRY_DSN = '';"));
});

test('every export the template declares survives seeding', () => {
  // The assertion #77 could not make: its fixture was a config.js of one line, so
  // "the seed is missing exports the app imports" was not expressible.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';");
  harness.applyPatches(wt, 8001, 3001);
  assert.deepEqual(
    exportsOf(wt),
    ['apiUrl', 'googleApiClientId', 'USE_CALENDAR_API', 'SENTRY_DSN', 'HOTJAR_SITE_ID'],
  );
});

test("a developer's own value wins over the template's placeholder", () => {
  // Composing must not flatten a real local setup back to placeholders.
  const wt = seeded([
    'export const apiUrl = "http://localhost:8000/";',
    'export const USE_CALENDAR_API = true;',
    "export const googleApiClientId = 'real-client-id';",
  ].join('\n'));
  harness.applyPatches(wt, 8001, 3001);
  assert.ok(configOf(wt).includes('export const USE_CALENDAR_API = true;'));
  assert.ok(configOf(wt).includes("export const googleApiClientId = 'real-client-id';"));
});

test('apiUrl is written from the leased port, whatever quote style arrived', () => {
  const wt = seeded('export const apiUrl = "http://localhost:8000/";');
  harness.applyPatches(wt, 8001, 3001);
  assert.ok(configOf(wt).includes("export const apiUrl = 'http://localhost:8001/';"));
});

test('a missing seed copy is composed from the template rather than refused', () => {
  // ONESHOT_SEED_COPIES can fail (EPERM on a provenance xattr) or simply not be set.
  // The template alone is enough to boot the app.
  const wt = seeded(undefined);
  harness.applyPatches(wt, 8001, 3001);
  assert.ok(existsSync(join(wt, 'frontend/src/constants/config.js')));
  assert.ok(configOf(wt).includes("export const apiUrl = 'http://localhost:8001/';"));
});

test('composing is idempotent', () => {
  // `ensure` runs on every phase; the second call must not churn the file.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';");
  harness.applyPatches(wt, 8001, 3001);
  const first = configOf(wt);
  assert.equal(harness.applyPatches(wt, 8001, 3001).apiUrl, false);
  assert.equal(configOf(wt), first);
});

test('an app repo with no template falls back to patching in place', () => {
  // Not every checkout is this app. Without config.example.js the old in-place
  // patch still applies, rather than the harness inventing a config it cannot know.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';", null);
  harness.applyPatches(wt, 8001, 3001);
  assert.equal(configOf(wt).trim(), "export const apiUrl = 'http://localhost:8001/';");
});

test('a template that declares no apiUrl at all is refused, not guessed at', () => {
  // The strictness #77 was right about, relocated to where it still applies. Patching
  // had to refuse an apiUrl line it could not match; composing writes that line, so
  // the only shape it cannot survive is a template that never declares the key.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';",
    "export const SENTRY_DSN = '';");
  assert.throws(() => harness.applyPatches(wt, 8001, 3001), /E_PATCH_FAILED|no apiUrl/);
});

test('a computed apiUrl in the template is replaced by the leased literal', () => {
  // A deliberate relaxation of #77's "refuse to guess": composing does not guess, it
  // writes. Whatever expression the template uses, the harness needs the SPA pointed
  // at the port it actually leased.
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';",
    'export const apiUrl = buildUrl(port);');
  harness.applyPatches(wt, 8001, 3001);
  assert.equal(configOf(wt).trim(), "export const apiUrl = 'http://localhost:8001/';");
});

/* ------------------------------------------------------------ staticfiles */

test('a worktree without a manifest needs collectstatic', () => {
  // staticfiles/ is gitignored in the app repo, so a fresh worktree never has one
  // and every {% static %} template 500s until it does.
  const wt = seeded();
  assert.equal(harness.needsCollectstatic(wt), true);
  mkdirSync(join(wt, 'staticfiles'), { recursive: true });
  writeFileSync(join(wt, 'staticfiles/staticfiles.json'), '{"paths":{}}');
  assert.equal(harness.needsCollectstatic(wt), false);
});

/* -------------------------------------------------------------- waitDjango */

/** A server that answers `status` on every request, on an OS-assigned port. */
async function serving(status: number): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((_req, res) => { res.writeHead(status); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { port, close: () => server.close() };
}

test('a process answering 500 is reported as 5xx, not as dead', async () => {
  // The misreport that cost ticket 256 its reproduction: waitDjango accepted only
  // 200, so a live process serving a missing-manifest traceback read as "Django did
  // not answer" and the phase retried a bring-up that could never succeed.
  const s = await serving(500);
  try {
    await assert.rejects(
      () => harness.waitDjango(s.port, process.pid, 30000),
      (e: { code: string; message: string }) => {
        assert.equal(e.code, 'E_DJANGO_5XX');
        assert.match(e.message, /answers 500/);
        return true;
      },
    );
  } finally { s.close(); }
});

test('a 200 still passes', async () => {
  const s = await serving(200);
  try {
    assert.equal(await harness.waitDjango(s.port, process.pid, 30000), true);
  } finally { s.close(); }
});

test('nothing listening is still reported as dead, not as 5xx', async () => {
  // A closed port yields status 0, which must not be mistaken for an application
  // error — that distinction is the entire value of the new code.
  const s = await serving(200);
  const { port } = s;
  s.close();
  await assert.rejects(
    () => harness.waitDjango(port, process.pid, 3000),
    (e: { code: string }) => e.code === 'E_DJANGO_DEAD',
  );
});

/* ------------------------------------------------- disabled integrations */

test('an environment it cannot interrogate reports nothing, and does not throw', () => {
  // Advisory, never a blocker. There is no venv in this temp worktree, so the
  // interpreter cannot run - and not knowing which integrations are off is not a
  // reason to stop an app that is otherwise healthy from coming up. The same
  // rule testlogin.ts states: a pre-check must never be the thing that fails a run.
  const wt = seeded();
  assert.deepEqual(harness.disabledIntegrations(wt), []);
});
