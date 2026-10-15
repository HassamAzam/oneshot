/**
 * A throwaway ONESHOT_HOME for tests that spawn hooks/automation-ready.cjs.
 *
 * Its config/ is a symlink to this repo's, so the script reads the real labels
 * and branch policy; its state/ is its own, so the `automation_ready` verdict
 * the script appends to $ONESHOT_HOME/state/hook-events.jsonl lands in a temp
 * dir instead of this checkout's live state/, which the board collector reads.
 * Without it, every suite run left a dozen fake precheck verdicts for an
 * invented ticket in the live log.
 *
 * Imports nothing from config, so a test that must set its environment before
 * config loads can still import it first.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function scratchHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'oneshot-ready-'));
  symlinkSync(join(REPO, 'config'), join(home, 'config'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
