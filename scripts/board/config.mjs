import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Oneshot's own .env — the collector is configured alongside everything else. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const p of [join(ROOT, '.env')]) {
  if (!existsSync(p)) continue;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// An empty value in .env means "unset", not "empty string": a `KEY=` line left
// blank would otherwise reach ?? as '' and win over the default.
const env = (k, d = '') => { const v = process.env[k]; return v === undefined || v === '' ? d : v; };
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const flag = (k) => /^(1|true|yes)$/i.test(process.env[k] ?? '');

const stateDir = env('BOARD_STATE_DIR', join(homedir(), '.oneshot-board'));

export const CFG = {
  oneshotHome: env('ONESHOT_HOME', ROOT),
  // The board's Postgres — the collector writes to it directly (same server).
  databaseUrl: env('BOARD_DATABASE_URL', ''),
  operator: env('BOARD_OPERATOR', '').trim(),
  stateDir,
  // Screenshots and videos, content-addressed: <mediaDir>/<run_id>/<sha256>.<ext>. The board serves it.
  mediaDir: env('BOARD_MEDIA_DIR', join(stateDir, 'media')),
  maxMediaBytes: num('BOARD_MAX_MEDIA_BYTES', 100_000_000),
  scanMs: num('BOARD_SCAN_INTERVAL_MS', 5_000),
  flushMs: num('BOARD_FLUSH_INTERVAL_MS', 60_000),
  maxBatchBytes: num('BOARD_MAX_BATCH_BYTES', 1_500_000),
  maxToolOutputBytes: num('BOARD_MAX_TOOL_OUTPUT_BYTES', 512_000),
  maxLineBytes: num('BOARD_MAX_LINE_BYTES', 1_000_000),
  // How long a live phase may be silent before it is FLAGGED (not killed off).
  stalledAfterMs: num('BOARD_STALLED_AFTER_MS', 15 * 60_000),
  dryRun: flag('BOARD_DRY_RUN'),
};
