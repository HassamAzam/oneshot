/**
 * The browser harness's port patches.
 *
 * Lives under src/ because that is the only tree `npm test` globs, while the
 * harness itself ships inside the skill that uses it. It is reached through
 * the API that skill already exports for scripts/app.cjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './config.js';

const require = createRequire(import.meta.url);
const harness = require(
  join(ROOT, 'skills/local-browser-verify/scripts/harness.cjs'),
) as { applyPatches: (wt: string, bePort: number, fePort: number) => unknown };

/** A worktree with just the two files applyPatches pins. */
function seeded(apiUrlLine: string): string {
  const wt = mkdtempSync(join(tmpdir(), 'harness-patch-'));
  mkdirSync(join(wt, 'frontend/config'), { recursive: true });
  mkdirSync(join(wt, 'frontend/src/constants'), { recursive: true });
  writeFileSync(
    join(wt, 'frontend/config/localPaths.js'),
    "const LOCAL_PUBLIC_URL = 'http://localhost:3000';\n",
  );
  writeFileSync(join(wt, 'frontend/src/constants/config.js'), `${apiUrlLine}\n`);
  return wt;
}

const apiUrlOf = (wt: string): string =>
  readFileSync(join(wt, 'frontend/src/constants/config.js'), 'utf8').trim();

test('a double-quoted apiUrl is patched, not rejected', () => {
  // The seeded file is copied verbatim from a developer's own checkout
  // (ONESHOT_SEED_COPIES) and is gitignored there, so its quote style is not
  // something this repo controls. Requiring single quotes threw E_PATCH_FAILED
  // on every worktree and no app ever started.
  const wt = seeded('export const apiUrl = "http://localhost:8000/";');
  harness.applyPatches(wt, 8001, 3001);
  assert.equal(apiUrlOf(wt), "export const apiUrl = 'http://localhost:8001/';");
});

test('a single-quoted apiUrl still works', () => {
  const wt = seeded("export const apiUrl = 'http://localhost:8000/';");
  harness.applyPatches(wt, 8001, 3001);
  assert.equal(apiUrlOf(wt), "export const apiUrl = 'http://localhost:8001/';");
});

test('an already-patched file is left on the right port', () => {
  // `ensure` is idempotent: a second call must not throw on its own output.
  const wt = seeded("export const apiUrl = 'http://localhost:8001/';");
  harness.applyPatches(wt, 8001, 3001);
  assert.equal(apiUrlOf(wt), "export const apiUrl = 'http://localhost:8001/';");
});

test('a file whose shape really did change is still refused', () => {
  // The strictness is the point — widening the quote class must not turn
  // patchFile into something that guesses.
  const wt = seeded('export const apiUrl = buildUrl(port);');
  assert.throws(() => harness.applyPatches(wt, 8001, 3001), /E_PATCH_FAILED|expected exactly 1/);
});
