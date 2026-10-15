/**
 * Recording mechanics for the demo-recording phase.
 *
 * The JUDGEMENT — which journey tells the story, what each caption says — is the
 * session's and lives in the flow it writes. This file owns only the parts that
 * cost a run to get right once already: a Playwright context that records video,
 * a session whose login is FRESH (a stale storage-state renders /home but
 * ERR_ABORTs every module nav), a caption overlay that reads as demo chrome, and
 * flushing the webm to a known path.
 *
 * It builds on local-browser-verify's harness for the app facts (login nuances,
 * websocket block, module routes) rather than re-deriving them. Resolve both
 * through ONESHOT_HOME so this works from any leased worktree.
 *
 * Two surfaces: the default records the React SPA (gotoModule). `admin: true`
 * records an admin-only feature with no React surface — it authenticates against
 * the Django admin (gotoAdmin) and needs only Django, never the webpack bundle.
 */
const fs = require('fs');
const path = require('path');

const ONESHOT_HOME = process.env.ONESHOT_HOME || path.resolve(__dirname, '../../../..');

/**
 * A phase session is given ONESHOT_TICKET but neither ONESHOT_IID nor
 * ONESHOT_RUN_DIR, so the harness would fall back to state/runs/adhoc while
 * scripts/app.cjs (which the session runs first) writes app-env.json and the
 * fresh storage-state under state/runs/<ticket>. Pin ONESHOT_RUN_DIR to the
 * same dir app.cjs uses before loading the harness, so the login this file
 * forces off-camera is the one the recording context then reuses — otherwise
 * the context opens unauthenticated and the login form is driven on camera.
 */
if (!process.env.ONESHOT_RUN_DIR) {
  const iid = process.env.ONESHOT_IID || process.env.ONESHOT_TICKET;
  if (iid) process.env.ONESHOT_RUN_DIR = path.join(ONESHOT_HOME, 'state', 'runs', String(iid));
}

const HARNESS = path.join(ONESHOT_HOME, '.claude/skills/local-browser-verify/scripts/harness.cjs');
const h = require(HARNESS);

function requirePlaywright() {
  const paths = [ONESHOT_HOME, path.join(ONESHOT_HOME, 'node_modules')];
  return require(require.resolve('playwright', { paths }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appEnvPath() {
  if (process.env.ONESHOT_RUN_DIR) return path.join(process.env.ONESHOT_RUN_DIR, 'harness/app-env.json');
  const iid = process.env.ONESHOT_IID || process.env.ONESHOT_TICKET || 'adhoc';
  return path.join(ONESHOT_HOME, 'state/runs', String(iid), 'harness/app-env.json');
}

function storagePath() {
  if (process.env.ONESHOT_RUN_DIR) return path.join(process.env.ONESHOT_RUN_DIR, 'harness/storage-state.json');
  const iid = process.env.ONESHOT_IID || process.env.ONESHOT_TICKET || 'adhoc';
  return path.join(ONESHOT_HOME, 'state/runs', String(iid), 'harness/storage-state.json');
}

function baseUrl() {
  if (process.env.ONESHOT_PORT) return `http://localhost:${process.env.ONESHOT_PORT}`;
  const raw = JSON.parse(fs.readFileSync(appEnvPath(), 'utf8'));
  return (raw.app || raw).baseUrl;
}

function credentials() {
  const raw = process.env.ONESHOT_TEST_LOGIN || '';
  const idx = raw.indexOf(':');
  if (idx < 1) throw new Error('ONESHOT_TEST_LOGIN is unset or not in email:password form');
  return { email: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

const onAdminLogin = (url) => new URL(url).pathname.includes('/login');

/**
 * Establish a Django-admin session, for admin-only features that have no React surface.
 *
 * Server-rendered, so it needs only Django on ONESHOT_PORT — never the webpack bundle.
 * Reuse-first: the SPA login (core login_user) calls django.contrib.auth.login, so a
 * leased app whose storage-state was written by any earlier phase already carries an
 * admin-capable session for a staff account — this just confirms and keeps it. Only a
 * missing/stale session falls back to the admin form. ERP usernames are the email's
 * local part, not the full email, so both are tried. Runs in a throwaway context (the
 * same off-camera pattern h.login uses) and saves the session for the recording context.
 */
async function adminLogin(session) {
  const { page, env } = session;
  await page.goto(`${env.baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
  if (!onAdminLogin(page.url())) {
    await session.context.storageState({ path: storagePath() });
    return { reused: true };
  }
  const { email, password } = credentials();
  for (const username of [email, email.split('@')[0]]) {
    const rendered = await page.waitForSelector('#id_username', { timeout: 30000 })
      .then(() => true).catch(() => false);
    if (!rendered) break;
    await page.fill('#id_username', username);
    await page.fill('#id_password', password);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (!onAdminLogin(page.url())) {
      await session.context.storageState({ path: storagePath() });
      return { reused: false, username };
    }
    await page.goto(`${env.baseUrl}/admin/login/`, { waitUntil: 'domcontentloaded' });
  }
  throw new Error('admin login failed — no reusable session and the form rejected ONESHOT_TEST_LOGIN; the account must be staff/superuser, or seed an authenticated storage-state via the leased app first');
}

const OVERLAY = (title) => {
  const install = () => {
    document.getElementById('demo-overlay-style')?.remove();
    const style = document.createElement('style');
    style.id = 'demo-overlay-style';
    style.textContent = `
      #demo-title{position:fixed;top:0;left:0;right:0;z-index:2147483647;
        background:linear-gradient(90deg,#0b5fff,#00b3a4);color:#fff;
        font:600 15px/40px -apple-system,Segoe UI,Roboto,sans-serif;height:40px;
        padding:0 18px;letter-spacing:.2px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
      #demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
        z-index:2147483647;background:rgba(17,24,39,.94);color:#fff;
        font:500 16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
        padding:12px 20px;border-radius:12px;max-width:72vw;text-align:center;
        box-shadow:0 8px 30px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);
        opacity:0;transition:opacity .25s ease}
      #demo-caption .step{display:inline-block;background:#00b3a4;color:#042b27;
        font-weight:700;border-radius:999px;padding:2px 10px;margin-right:10px;font-size:13px}
      #demo-caption.show{opacity:1}
      .demo-ring{outline:3px solid #ffcf33 !important;outline-offset:2px !important;
        border-radius:6px !important}`;
    document.head.appendChild(style);
    if (!document.getElementById('demo-title')) {
      const t = document.createElement('div'); t.id = 'demo-title'; t.textContent = title;
      document.body.appendChild(t);
    }
    if (!document.getElementById('demo-caption')) {
      const c = document.createElement('div'); c.id = 'demo-caption';
      document.body.appendChild(c);
    }
  };
  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
};

/**
 * Bring up a recording session already authenticated, with video capture on.
 *
 * Refreshes the session OFF-CAMERA in a throwaway context (a real force login
 * that rewrites storage-state.json), then opens the recording context reusing
 * that fresh state and lands it on an authenticated page. The recorded video
 * therefore starts from the app, never from the login form.
 *
 * opts.admin selects the surface: the default (false) records the React SPA —
 * logs in through the app and lands on /home. `admin: true` records an
 * admin-only feature (one with no React surface): it logs in to the Django admin
 * instead, needs only Django on ONESHOT_PORT (never the webpack bundle), and
 * lands on /admin/. Drive admin pages with gotoAdmin, SPA modules with gotoModule.
 *
 * opts: { outDir, title, slowMo?, viewport?, admin? }
 * returns: { browser, context, page, session, baseUrl, admin, caption, ring, title }
 */
async function startRecording(opts) {
  const outDir = opts.outDir;
  const title = opts.title || 'Demo';
  const viewport = opts.viewport || { width: 1440, height: 900 };
  const admin = opts.admin === true;
  const url = baseUrl();
  fs.mkdirSync(outDir, { recursive: true });

  const pw = requirePlaywright();
  const browser = await pw.chromium.launch({ headless: true, slowMo: opts.slowMo ?? 220 });

  try {
    return await buildRecording({ browser, outDir, title, viewport, admin, url });
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function buildRecording({ browser, outDir, title, viewport, admin, url }) {
  const storage = storagePath();
  const warmCtx = await browser.newContext({
    viewport, ignoreHTTPSErrors: true,
    ...(admin && fs.existsSync(storage) ? { storageState: storage } : {}),
  });
  const warmPage = await warmCtx.newPage();
  await warmPage.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  const warmSession = { page: warmPage, env: { baseUrl: url }, context: warmCtx, browser, consoleErrors: [] };
  if (admin) await adminLogin(warmSession);
  else await h.login(warmSession, { force: true });
  await warmCtx.close();
  const context = await browser.newContext({
    viewport, ignoreHTTPSErrors: true,
    recordVideo: { dir: outDir, size: viewport },
    ...(fs.existsSync(storage) ? { storageState: storage } : {}),
  });
  await context.addInitScript(OVERLAY, title);
  const page = await context.newPage();
  await page.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  const session = { page, env: { baseUrl: url }, context, browser, consoleErrors: [] };
  if (admin) await page.goto(`${url}/admin/`, { waitUntil: 'domcontentloaded' });
  else await h.login(session);
  await sleep(600);

  const caption = async (step, text, holdMs = 1500) => {
    await page.evaluate(
      ([s, txt]) => {
        const c = document.getElementById('demo-caption');
        if (!c) return;
        c.innerHTML = (s ? `<span class="step">${s}</span>` : '') + txt;
        c.classList.add('show');
      },
      [step, text],
    );
    await sleep(holdMs);
  };

  const ring = async (locator) => {
    try {
      const eh = await locator.first().elementHandle({ timeout: 4000 });
      if (!eh) return;
      await eh.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await eh.evaluate((el) => el.classList.add('demo-ring'));
      await sleep(500);
      await eh.evaluate((el) => el.classList.remove('demo-ring'));
    } catch { /* cosmetic */ }
  };

  const installOverlay = async () => { await page.evaluate(OVERLAY, title); };

  return { browser, context, page, session, baseUrl: url, admin, caption, ring, installOverlay, title, harness: h, sleep };
}

/**
 * Navigate to a known local-browser-verify module key, then paint the overlay.
 * Uses the harness so the ERR_ABORT / readiness nuances stay in one place.
 */
async function gotoModule(rec, key, timeout = 45000) {
  const r = await rec.harness.goto(rec.session, key, { timeout });
  await rec.page.waitForLoadState('networkidle').catch(() => {});
  await rec.installOverlay();
  return r;
}

/**
 * Navigate to a server-rendered page (typically the Django admin) that has no
 * module-registry key, then paint the overlay. This is the journey path for
 * admin-only features. `pathOrUrl` is an absolute URL or a path like
 * '/admin/payroll/fixedbillingsalaryrecord/'.
 */
async function gotoAdmin(rec, pathOrUrl, timeout = 30000) {
  const target = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${rec.baseUrl}${pathOrUrl}`;
  await rec.page.goto(target, { waitUntil: 'domcontentloaded', timeout });
  await rec.page.waitForLoadState('networkidle').catch(() => {});
  await rec.installOverlay();
  return { url: rec.page.url() };
}

/**
 * Close the context (which flushes the video), then rename the webm to a stable
 * name and return its absolute path. Does NOT stop the app servers — the run
 * reaps them by pid, and a later phase reuses the warm app.
 */
/**
 * Tear down a recording that failed mid-journey, before a retry.
 *
 * finishRecording needs a live page with a flushed video, so it cannot close a
 * context that died on login or navigation. Call this on the error path so the
 * retry's startRecording does not leave a second chromium and a stale recording
 * context alive until the node process exits. Best-effort and idempotent.
 */
async function abortRecording(rec) {
  if (!rec) return;
  try { await rec.context?.close(); } catch { /* already gone */ }
  try { await rec.browser?.close(); } catch { /* already gone */ }
}

async function finishRecording(rec, finalName = 'demo.webm') {
  const video = rec.page.video();
  await rec.context.close();
  await rec.browser.close();
  if (!video) return null;
  const src = await video.path().catch(() => null);
  if (!src) return null;
  const dest = path.join(path.dirname(src), finalName);
  try { fs.renameSync(src, dest); return dest; } catch { return src; }
}

module.exports = { startRecording, gotoModule, gotoAdmin, adminLogin, finishRecording, abortRecording, baseUrl, sleep, harness: h };
