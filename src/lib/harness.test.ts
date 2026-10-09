/**
 * The browser harness's bring-up preconditions, and the contract of its overlap
 * measurement.
 *
 * Lives under src/ because that is the only tree `npm test` globs, while the
 * harness itself ships inside the skill that uses it. It is reached through
 * the API that skill already exports for scripts/app.cjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync,
} from 'node:fs';
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
  waitWebpack: (
    wt: string, port: number, pid: number, budgetMs: number, startedAt?: number,
  ) => Promise<boolean>;
  bundleState: (wt: string, opts?: { since?: number; log?: string }) => BundleState;
  assertBundleReachable: (bePort: number) => Promise<string>;
  settle: (session: unknown, selector: string, opts?: Budget) => Promise<Settled>;
  overlap: (session: unknown, a: string, b: string, opts?: Budget) => Promise<Overlap>;
};

interface Box { x: number; y: number; width: number; height: number }
interface BundleState { state: 'ready' | 'building' | 'failed'; via: string | null; detail: string | null }
interface Budget { timeout?: number; quiet?: number }
interface Settled { box: Box | null; settled: boolean }
interface Overlap {
  intersects: boolean | null;
  areaPx: number | null;
  region?: { width: number; height: number; areaPx: number };
  missing?: string[];
  hidden?: Array<{ selector: string; why: string | null }>;
  unsettled: string[];
  outsideViewport?: boolean;
}

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

/* ------------------------------------------------------------- waitWebpack */

const ENTRYPOINTS = 'static/webpack-entrypoints.dev.json';
const STATS = 'static/webpack-stats.dev.json';
const FE_PORT = 9030;

/** What react-dev-utils prints on a cold start, up to the line that ends the build. */
const BOOT = [
  '> hrdb@1.0.0 start',
  '> node frontend/scripts/start.js',
  '',
  'Starting the development server...',
  '',
  `ℹ ｢wds｣: webpack output is served from http://localhost:${FE_PORT}/`,
].join('\n');

/**
 * A worktree and a run directory as up() leaves them once webpack has been started:
 * the log truncated and then written by this webpack alone, and whichever manifests the
 * checkout's webpack config writes, each dated on purpose relative to `startedAt`.
 */
function bundleFixture(log: string, files: Record<string, { body: object; mtimeMs: number }> = {}) {
  const wt = mkdtempSync(join(tmpdir(), 'harness-webpack-wt-'));
  const run = mkdtempSync(join(tmpdir(), 'harness-webpack-run-'));
  mkdirSync(join(wt, 'static'), { recursive: true });
  mkdirSync(join(run, 'harness'), { recursive: true });
  writeFileSync(join(run, 'harness/webpack.log'), log);
  for (const [rel, { body, mtimeMs }] of Object.entries(files)) {
    writeFileSync(join(wt, rel), JSON.stringify(body));
    utimesSync(join(wt, rel), mtimeMs / 1000, mtimeMs / 1000);
  }
  return { wt, run, log: join(run, 'harness/webpack.log') };
}

/** waitWebpack reads the log from the run directory, as every harness command does. */
async function inRun<T>(run: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ONESHOT_RUN_DIR;
  process.env.ONESHOT_RUN_DIR = run;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ONESHOT_RUN_DIR;
    else process.env.ONESHOT_RUN_DIR = prev;
  }
}

/** The manifest EntrypointFilesPlugin writes: no status field, ever. */
const MANIFEST = {
  hash: '3f9c2a',
  entrypoints: {
    main: [
      `http://localhost:${FE_PORT}/static/js/vendors~main.chunk.js`,
      `http://localhost:${FE_PORT}/static/js/bundle.js`,
    ],
  },
};

const started = Date.now() - 60_000;
const afterStart = Date.now();
const beforeStart = started - 3_600_000;

test('a fresh entrypoints manifest plus a finished compile in the log is ready', async () => {
  // The bug every fresh worktree on current app code hit: the app writes
  // webpack-entrypoints.dev.json, which has no status, and the harness waited 20
  // minutes for a "done" that file never carries while webpack had already logged
  // `Compiled with warnings.`.
  const f = bundleFixture(`${BOOT}\nCompiled with warnings.\n\nsrc/x.js\n  Line 3:  'y' is defined but never used  no-unused-vars\n`, {
    [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: afterStart },
  });
  assert.equal(await inRun(f.run, () => harness.waitWebpack(f.wt, FE_PORT, process.pid, 5000, started)), true);
  assert.deepEqual(harness.bundleState(f.wt, { since: started, log: f.log }),
    { state: 'ready', via: ENTRYPOINTS, detail: null });
});

test('a coloured "Compiled successfully!" counts as a finished compile too', () => {
  // FORCE_COLOR in the environment turns chalk on even with stdout on a file.
  const f = bundleFixture(`${BOOT}\n\u001b[32mCompiled successfully!\u001b[39m\n`, {
    [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: afterStart },
  });
  assert.equal(harness.bundleState(f.wt, { since: started, log: f.log }).state, 'ready');
});

test('an entrypoints manifest older than this webpack is not ready', async () => {
  // A worktree reused across refs keeps the previous build's manifest. Taking it as
  // this build's would point Django at chunk names this compile may not have emitted.
  const f = bundleFixture(`${BOOT}\nCompiled successfully!\n`, {
    [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: beforeStart },
  });
  const state = harness.bundleState(f.wt, { since: started, log: f.log });
  assert.equal(state.state, 'building');
  assert.match(String(state.detail), /neither a fresh static\/webpack-entrypoints\.dev\.json/);
  await assert.rejects(
    () => inRun(f.run, () => harness.waitWebpack(f.wt, FE_PORT, process.pid, 300, started)),
    (e: { code: string; message: string; hint: string }) => {
      assert.equal(e.code, 'E_WEBPACK_DEAD');
      // localtests.cjs keys its keep-waiting path on this phrase.
      assert.match(e.message, /did not reach status/);
      assert.match(e.hint, /neither a fresh/);
      return true;
    },
  );
});

test('a caller with no start time dates the manifest against the process start', async () => {
  // app.cjs joins a bring-up somebody else started and has no start time to pass.
  // Falling back to "any mtime" would accept a manifest from a day-old build.
  const f = bundleFixture(`${BOOT}\nCompiled successfully!\n`, {
    [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: Date.now() - 86_400_000 },
  });
  await assert.rejects(
    () => inRun(f.run, () => harness.waitWebpack(f.wt, FE_PORT, process.pid, 300)),
    (e: { code: string; message: string }) => e.code === 'E_WEBPACK_DEAD' && /did not reach status/.test(e.message),
  );
});

test('a rebuild that started after the last result is still building', () => {
  // Only the LAST marker counts: an earlier `Compiled` is history once `Compiling...`
  // follows it, even though the manifest from that earlier compile is fresh.
  const f = bundleFixture(`${BOOT}\nCompiled successfully!\nCompiling...\n`, {
    [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: afterStart },
  });
  assert.equal(harness.bundleState(f.wt, { since: started, log: f.log }).state, 'building');
});

test('"Failed to compile" as the latest result is a build error carrying its error lines', async () => {
  // The plugin writes the manifest from webpack's `done` hook, which fires for a failed
  // compile too — so a fresh manifest is not success, and the log has to say which.
  const f = bundleFixture(
    `${BOOT}\nFailed to compile.\n\n./src/sentryConfig.js\nAttempted import error: 'SENTRY_DSN' is not exported from './constants/config'.\n`,
    { [ENTRYPOINTS]: { body: MANIFEST, mtimeMs: afterStart } },
  );
  await assert.rejects(
    () => inRun(f.run, () => harness.waitWebpack(f.wt, FE_PORT, process.pid, 5000, started)),
    (e: { code: string; message: string; hint: string }) => {
      assert.equal(e.code, 'E_WEBPACK_DEAD');
      assert.match(e.message, /build error/);
      assert.match(e.hint, /SENTRY_DSN' is not exported/);
      return true;
    },
  );
});

test('a checkout that still writes webpack-stats is ready on status "done", as before', async () => {
  // The old shape must keep working for refs older than the app's chunk split. The log
  // here has not printed a result yet: the stats file alone is the answer for them.
  const f = bundleFixture(BOOT, {
    [STATS]: { body: { status: 'done', chunks: { main: [] } }, mtimeMs: afterStart },
  });
  assert.equal(await inRun(f.run, () => harness.waitWebpack(f.wt, FE_PORT, process.pid, 5000, started)), true);
  assert.equal(harness.bundleState(f.wt, { since: started, log: f.log }).via, STATS);
});

test('a "done" stats file left by an earlier build does not stand in for this one', () => {
  // A reused worktree that has moved past the chunk split still holds the old
  // webpack-stats.dev.json. Its `done` describes a build Django no longer reads.
  const f = bundleFixture(BOOT, {
    [STATS]: { body: { status: 'done', chunks: { main: [] } }, mtimeMs: beforeStart },
  });
  assert.equal(harness.bundleState(f.wt, { since: started, log: f.log }).state, 'building');
});

test('the bundle probe prefers the entry bundle over the vendor chunk and gtag', async () => {
  // render_entrypoint emits the split chunks BEFORE static/js/bundle.js, after Google's
  // loader at the top of the page. The first .js tag is not the app's own code.
  const requested: string[] = [];
  const server: Server = createServer((req, res) => {
    requested.push(String(req.url));
    if (req.url === '/login/') {
      const { port: p } = server.address() as { port: number };
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end([
        '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>',
        '<script>window.dataLayer = [];</script>',
        `<script src="http://localhost:${p}/static/js/vendors~main.chunk.js" async></script>`,
        `<script src="http://localhost:${p}/static/js/bundle.js" async></script>`,
      ].join('\n'));
      return;
    }
    res.writeHead(200); res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const url = await harness.assertBundleReachable(port);
    assert.equal(url, `http://localhost:${port}/static/js/bundle.js`);
    assert.ok(requested.includes('/static/js/bundle.js'));
  } finally { server.close(); }
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

/* ---------------------------------------------------------------- overlap */

const POPPER = '.react-datepicker-popper';
const FIELD = '[name="training.end_date"]';
/** Small enough that a side which never resolves costs 300ms, not the 5s default. */
const FAST = { timeout: 300, quiet: 60 };

/**
 * The page a measurement sees, answered from tables. settle() and overlap() touch only
 * `locator(sel).first().boundingBox()`, `.evaluate()` and `viewportSize()`, so a plain
 * object drives them with no browser. A box given as a function is re-read on every
 * probe, which is how a moving element is staged.
 */
interface Stage {
  boxes: Record<string, Box | (() => Box)>;
  seen?: Record<string, { visible: boolean; why: string | null }>;
  /** Selectors whose element is gone by the time it is inspected. */
  detached?: string[];
  /** Every inspection, with the argument and options it was handed. */
  probes?: Array<{ arg: unknown; options: unknown }>;
}

function staged(stage: Stage) {
  return {
    page: {
      viewportSize: () => ({ width: 1440, height: 900 }),
      locator: (selector: string) => ({
        first: () => ({
          boundingBox: async () => {
            const box = stage.boxes[selector];
            return typeof box === 'function' ? box() : box ?? null;
          },
          evaluate: async (_fn: unknown, arg?: unknown, options?: unknown) => {
            stage.probes?.push({ arg, options });
            if (stage.detached?.includes(selector)) {
              throw new Error('locator.evaluate: element is not attached to the DOM');
            }
            return stage.seen?.[selector] ?? { visible: true, why: null };
          },
        }),
      }),
    },
  };
}

const at = (x: number, y: number, width = 100, height = 100): Box => ({ x, y, width, height });

test('a field that never resolves a box is reported as missing, not as no overlap', async () => {
  // The dangerous reading: "I could not find it" taken as "nothing is covering it"
  // files a working screen as a product bug, which is what ticket 244 paid for.
  const r = await harness.overlap(staged({ boxes: { [POPPER]: at(0, 0) } }), POPPER, FIELD, FAST);
  assert.equal(r.intersects, null);
  assert.equal(r.areaPx, null);
  assert.deepEqual(r.missing, [FIELD]);
});

test('a missing field and a missing popper are told apart by which one is named', async () => {
  // The calendar check reads a vanished popper as "closed and stayed closed" and a
  // vanished field as a locator question. Both come back as intersects:null, so
  // `missing` is the only thing that separates a pass from a false pass.
  const noField = await harness.overlap(staged({ boxes: { [POPPER]: at(0, 0) } }), POPPER, FIELD, FAST);
  const noPopper = await harness.overlap(staged({ boxes: { [FIELD]: at(0, 0) } }), POPPER, FIELD, FAST);
  assert.deepEqual(noField.missing, [FIELD]);
  assert.deepEqual(noPopper.missing, [POPPER]);
});

test('two visible boxes that overlap report the area they share', async () => {
  const r = await harness.overlap(
    staged({ boxes: { [POPPER]: at(0, 0), [FIELD]: at(50, 50) } }), POPPER, FIELD, FAST,
  );
  assert.equal(r.intersects, true);
  assert.equal(r.areaPx, 2500);
  assert.deepEqual(r.region, { width: 50, height: 50, areaPx: 2500 });
  assert.deepEqual(r.unsettled, []);
  assert.equal(r.outsideViewport, false);
});

test('areaPx comes from the unrounded sides, so it need not equal the rounded region', async () => {
  // Shaped like the live Training reading (10352 px² under a 242px popover): a band
  // 42.78px tall rounds to 43 in region, and 242 x 43 is 10406, but the area is 10353.
  // A reader checking areaPx against width x height must expect "about", not "equal".
  const r = await harness.overlap(
    staged({ boxes: { [POPPER]: at(0, 0, 242, 300), [FIELD]: at(0, 300 - 42.78, 242, 60) } }),
    POPPER, FIELD, FAST,
  );
  assert.equal(r.areaPx, 10353);
  assert.deepEqual(r.region, { width: 242, height: 43, areaPx: 10353 });
});

test('an overlay the user cannot see reports no intersection and names why', async () => {
  // opacity:0 keeps the box, so geometry alone measured a dismissed popover as
  // covering the field it no longer covers.
  const r = await harness.overlap(staged({
    boxes: { [POPPER]: at(0, 0), [FIELD]: at(50, 50) },
    seen: { [POPPER]: { visible: false, why: 'opacity:0.00' } },
  }), POPPER, FIELD, FAST);
  assert.equal(r.intersects, false);
  assert.equal(r.areaPx, 0);
  assert.deepEqual(r.hidden, [{ selector: POPPER, why: 'opacity:0.00' }]);
});

test('boxes that do not touch share zero area', async () => {
  const r = await harness.overlap(
    staged({ boxes: { [POPPER]: at(0, 0), [FIELD]: at(300, 300) } }), POPPER, FIELD, FAST,
  );
  assert.equal(r.intersects, false);
  assert.equal(r.areaPx, 0);
});

test('a box that holds still settles well inside its budget', async () => {
  const started = Date.now();
  const r = await harness.settle(staged({ boxes: { [POPPER]: at(10, 20) } }), POPPER, FAST);
  assert.deepEqual(r, { box: at(10, 20), settled: true });
  assert.ok(Date.now() - started < FAST.timeout, `took ${Date.now() - started}ms`);
});

/** A popper stuck re-anchoring: every probe finds it at the other placement. */
function flipping(): () => Box {
  let up = false;
  return () => { up = !up; return at(0, up ? 0 : 150); };
}

test('a box still moving when the budget runs out is returned as unsettled', async () => {
  const r = await harness.settle(staged({ boxes: { [POPPER]: flipping() } }), POPPER, FAST);
  assert.equal(r.settled, false);
  assert.ok(r.box, 'the last sample is still returned, for the evidence');
});

test('an overlay that never holds still is flagged unsettled rather than read as a measurement', async () => {
  // A popper flipping between two placements, only one of which covers the field,
  // gave whichever verdict the last sample happened to land on, with nothing to say
  // the element never came to rest.
  const r = await harness.overlap(
    staged({ boxes: { [POPPER]: flipping(), [FIELD]: at(0, 0) } }), POPPER, FIELD, FAST,
  );
  assert.deepEqual(r.unsettled, [POPPER]);
});

test('an overlay that detaches before it can be inspected is reported as missing, not as uncovered', async () => {
  // The popper resolved a box in settle() and was gone when its visibility was read.
  // That read failing used to land in `hidden`, so a measurement that never happened
  // came back as a clean intersects:false.
  const r = await harness.overlap(staged({
    boxes: { [POPPER]: at(0, 0), [FIELD]: at(50, 50) },
    detached: [POPPER],
  }), POPPER, FIELD, FAST);
  assert.equal(r.intersects, null);
  assert.equal(r.areaPx, null);
  assert.deepEqual(r.missing, [POPPER]);
});

test('the visibility probe carries its timeout as an option, inside the caller budget', async () => {
  // Locator.evaluate(fn, arg, options): a timeout passed second is the page function's
  // argument and is ignored, leaving the inspection on Playwright's 30s default.
  const probes: Array<{ arg: unknown; options: unknown }> = [];
  await harness.overlap(
    staged({ boxes: { [POPPER]: at(0, 0), [FIELD]: at(50, 50) }, probes }), POPPER, FIELD, FAST,
  );
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.equal(probe.arg, undefined);
    assert.deepEqual(probe.options, { timeout: FAST.timeout });
  }
});

test('an element above or left of the viewport is flagged outside it', async () => {
  // Boxes are viewport-relative, so a popper scrolled above the screen has a negative y.
  // Only the bottom and right edges were checked, so its zero read as a real one.
  for (const offscreen of [at(0, -500), at(-500, 0)]) {
    const r = await harness.overlap(
      staged({ boxes: { [POPPER]: offscreen, [FIELD]: at(0, 200) } }), POPPER, FIELD, FAST,
    );
    assert.equal(r.areaPx, 0);
    assert.equal(r.outsideViewport, true, JSON.stringify(offscreen));
  }
});

test('a box only partly past an edge is still on screen', async () => {
  const r = await harness.overlap(
    staged({ boxes: { [POPPER]: at(0, -50), [FIELD]: at(0, 0) } }), POPPER, FIELD, FAST,
  );
  assert.equal(r.outsideViewport, false);
  assert.equal(r.areaPx, 5000);
});

test('a hidden overlay reports outsideViewport from its box, not a fixed false', async () => {
  const r = await harness.overlap(staged({
    boxes: { [POPPER]: at(0, 1000), [FIELD]: at(0, 200) },
    seen: { [POPPER]: { visible: false, why: 'opacity:0.00' } },
  }), POPPER, FIELD, FAST);
  assert.equal(r.intersects, false);
  assert.equal(r.outsideViewport, true);
});
