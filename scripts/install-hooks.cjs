#!/usr/bin/env node
'use strict';
/**
 * Merge the Oneshot hook block into ~/.claude/settings.json.
 *
 * settings.json is Hassam's own file and may already contain hooks he needs,
 * so this is a MERGE, not a write. Every entry Oneshot adds is tagged
 * `oneshotManaged: true`, which is what lets uninstall remove exactly what was
 * added and nothing else. Running install twice is a no-op, not a duplicate.
 *
 * A timestamped backup is written before any change.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ONESHOT = path.resolve(__dirname, '..');
const SETTINGS_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(SETTINGS_DIR, 'settings.json');
const TEMPLATE = path.join(ONESHOT, 'hooks', 'hooks.settings.json');

const uninstall = process.argv.includes('--uninstall');

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    console.error(`\n~/.claude/settings.json is not valid JSON: ${err.message}`);
    console.error('Fix it by hand before installing hooks — refusing to overwrite it.\n');
    process.exit(1);
  }
}

function backup() {
  if (!fs.existsSync(SETTINGS)) return null;
  const dest = `${SETTINGS}.oneshot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

function stripOneshot(settings) {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((entry) => !entry.oneshotManaged);
    removed += before - settings.hooks[event].length;
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

const settings = readSettings();
const backupPath = backup();

if (uninstall) {
  const removed = stripOneshot(settings);
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Removed ${removed} Oneshot hook entr${removed === 1 ? 'y' : 'ies'}.`);
  if (backupPath) console.log(`Backup: ${backupPath}`);
  process.exit(0);
}

const nodeBin = process.env.ONESHOT_NODE || process.execPath;
const raw = fs.readFileSync(TEMPLATE, 'utf8')
  .replace(/__ONESHOT_HOME__/g, ONESHOT)
  .replace(/__NODE__/g, nodeBin);
const template = JSON.parse(raw);

// Remove any previous install first, so re-running after a path change
// replaces the block instead of stacking a second copy on top of it.
stripOneshot(settings);

settings.hooks = settings.hooks || {};
let added = 0;
for (const [event, entries] of Object.entries(template.hooks)) {
  settings.hooks[event] = settings.hooks[event] || [];
  for (const entry of entries) {
    settings.hooks[event].push({ ...entry, oneshotManaged: true });
    added += 1;
  }
}

fs.mkdirSync(SETTINGS_DIR, { recursive: true });
fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

console.log(`Installed ${added} Oneshot hook entries into ${SETTINGS}`);
console.log(`  ONESHOT_HOME = ${ONESHOT}`);
console.log(`  node         = ${nodeBin}`);
if (backupPath) console.log(`  backup       = ${backupPath}`);
console.log('\nEvery hook is gated on ONESHOT_PHASE, so your own interactive');
console.log('sessions are unaffected. Verify with: npm run hooks:verify\n');
