#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: the two mr-metadata rules, on every MR create and update.
 *
 *   1. The title carries no conventional-commit prefix.
 *   2. The description carries a `[closes <url>]` line.
 *
 * WHY THIS EXISTS WHEN A GATE ALREADY DID. context/scripts/mr_metadata_gate.py
 * enforces exactly this policy and has since before Oneshot had phases. It has
 * never once run here, for two independent reasons: it is wired in
 * context/settings.json, which claudedir deliberately does not link, and it
 * matches `mcp__gitlab-mcp__*` while every tool in this repo is
 * `mcp__gitlab__*`. Either alone would be enough to make it dead. Fixing the
 * wiring would not have been enough, and neither would fixing the names.
 *
 * The regexes are lifted from that script deliberately rather than reinvented,
 * so the two agree by construction for as long as both exist. Collapsing them
 * into one implementation is worth doing and is a bigger question than this
 * hook — it spans two repos with different runtimes.
 *
 * An update validates only the fields it actually sends: an update that does
 * not touch title or description has no opinion to check, and blocking it
 * would stop a phase adding a label.
 *
 * This is a PreToolUse deny rather than a PostToolUse block because the call is
 * the publication. A wrong title can be edited afterwards; the notification
 * that went to every reviewer cannot.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const GUARDED = new Set([
  'mcp__gitlab__create_merge_request',
  'mcp__gitlab__update_merge_request',
]);

const PREFIX_RE = /^(feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)(\(.+?\))?!?:\s*/i;
const CLOSES_RE = /\[closes\s+https?:\/\/\S+/i;

try {
  const data = C.readInput();
  if (GUARDED.has(data.tool_name || '')) {
    const input = data.tool_input || {};
    const isCreate = data.tool_name === 'mcp__gitlab__create_merge_request';
    const title = typeof input.title === 'string' ? input.title : null;
    const description = typeof input.description === 'string' ? input.description : null;

    if (title !== null && PREFIX_RE.test(title.trim())) {
      C.event('denied_mr_title_prefix', { title });
      C.deny(
        `Denied: the MR title starts with a conventional-commit prefix ` +
        `("${title.trim().slice(0, 60)}").\n` +
        'An MR title describes what the change delivers, in plain words a reviewer reads ' +
        'in a list — not what type of commit it was. Drop the prefix and say the thing: ' +
        '"Remove Unused Celery Task for Invoice Reminders", not "chore: remove unused ' +
        'celery task". On a multi-commit branch the last commit is usually misleading; ' +
        'title the branch\'s one deliverable. See the `mr-metadata` skill.',
      );
    }

    // On create the description is mandatory; on update it is only checked when sent.
    const needsCloses = isCreate || description !== null;
    if (needsCloses && !CLOSES_RE.test(description || '')) {
      C.event('denied_mr_no_closes', { hasDescription: description !== null });
      C.deny(
        'Denied: the MR description has no `[closes <ticket_url>]` line.\n' +
        'Every MR closes a ticket, and the link is what lets anyone reading the MR find ' +
        'out why the work happened. Add it on its own line:\n' +
        '  [closes https://gitlab.example.com/group/project/-/issues/412]\n' +
        'Use a ticket this diff actually addresses — never one that merely appeared in ' +
        'the session, and never a URL you have not confirmed exists. If there genuinely ' +
        'is no ticket, say so in `blocked` rather than inventing one. See the ' +
        '`mr-metadata` skill.',
      );
    }
  }
} catch (err) {
  C.logFailure('mr-gate', err);
}

C.allow();
