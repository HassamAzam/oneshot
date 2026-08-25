#!/usr/bin/env node
'use strict';
/**
 * Catch-all event logger. Appends one JSONL line per hook firing to
 * state/hook-events.jsonl.
 *
 * Deliberately writes a file rather than the SQLite DB: this runs on EVERY
 * tool call in every phase, and an append is the one write that cannot
 * contend with the conductor, the Slack listener, and the other hooks all
 * holding the same database.
 *
 * Never blocks. Never emits stdout.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const input = data.tool_input || {};

  // Metadata only. Tool ARGUMENTS can contain ticket bodies, diffs and file
  // contents; this file has no access control, so it records shapes not values.
  const summary = {};
  if (input.file_path) summary.file = String(input.file_path).slice(0, 200);
  if (input.command) summary.cmdHead = String(input.command).slice(0, 120);
  if (input.pattern) summary.pattern = String(input.pattern).slice(0, 80);

  C.event(data.hook_event_name || 'hook', {
    tool,
    session: data.session_id || null,
    ...summary,
  });
} catch (err) {
  C.logFailure('log-event', err);
}

process.exit(0);
