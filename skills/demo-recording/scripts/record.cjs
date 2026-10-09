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
 */
const fs = require('fs');
const path = require('path');

const ONESHOT_HOME = process.env.ONESHOT_HOME || path.resolve(__dirname, '../../../..');
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

const OVERLAY = (title) => {
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

/**
 * Bring up a recording session already authenticated, with video capture on.
 *
 * Refreshes the session OFF-CAMERA in a throwaway context (a real force login
 * that rewrites storage-state.json), then opens the recording context reusing
 * that fresh state and lands it on /home. The recorded video therefore starts
 * from an authenticated app, never from the login form.
 *
 * opts: { outDir, title, slowMo?, viewport? }
 * returns: { browser, context, page, session, baseUrl, caption, ring, title }
 */
async function startRecording(opts) {
  const outDir = opts.outDir;
  const title = opts.title || 'Demo';
  const viewport = opts.viewport || { width: 1440, height: 900 };
  const url = baseUrl();
  fs.mkdirSync(outDir, { recursive: true });

  const pw = requirePlaywright();
  const browser = await pw.chromium.launch({ headless: true, slowMo: opts.slowMo ?? 220 });

  const warmCtx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const warmPage = await warmCtx.newPage();
  await warmPage.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  await h.login({ page: warmPage, env: { baseUrl: url }, context: warmCtx, browser, consoleErrors: [] }, { force: true });
  await warmCtx.close();

  const storage = storagePath();
  const context = await browser.newContext({
    viewport, ignoreHTTPSErrors: true,
    recordVideo: { dir: outDir, size: viewport },
    ...(fs.existsSync(storage) ? { storageState: storage } : {}),
  });
  const page = await context.newPage();
  await page.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  const session = { page, env: { baseUrl: url }, context, browser, consoleErrors: [] };
  await h.login(session);
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
      const eh = await locator.elementHandle({ timeout: 4000 });
      if (!eh) return;
      await eh.evaluate((el) => el.classList.add('demo-ring'));
      await sleep(500);
      await eh.evaluate((el) => el.classList.remove('demo-ring'));
    } catch { /* cosmetic */ }
  };

  const installOverlay = async () => { await page.evaluate(OVERLAY, title); };

  return { browser, context, page, session, baseUrl: url, caption, ring, installOverlay, title, harness: h, sleep };
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
 * Close the context (which flushes the video), then rename the webm to a stable
 * name and return its absolute path. Does NOT stop the app servers — the run
 * reaps them by pid, and a later phase reuses the warm app.
 */
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

module.exports = { startRecording, gotoModule, finishRecording, baseUrl, sleep, harness: h };
