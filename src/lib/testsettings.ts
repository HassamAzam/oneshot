/**
 * Where the conductor puts a checkout's generated Django test settings, and the
 * dotted name Django loads them by.
 *
 * Apart from src/lib/worktrees.ts, which writes the file, on purpose: the phase
 * prompts name it too, and they must not have to import the worktree module —
 * and the SQLite handle it opens — to do so. See seedTestSettings() there and
 * config/erp/test_settings.template.py for what the file is and why it exists.
 */
export const TEST_SETTINGS_FILE = 'hrdb/test_settings_oneshot.py';
export const TEST_SETTINGS_MODULE = 'hrdb.test_settings_oneshot';
