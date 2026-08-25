#!/usr/bin/env node
'use strict';
/**
 * PreToolUse catch-all: the brake.
 *
 * With zero human gates in the pipeline, this is the ONLY thing that can stop
 * a run that is already in flight. `touch state/PAUSE` (or `pause` in Slack)
 * must take effect inside sessions that are mid-phase, not just prevent the
 * next one from starting.
 *
 * Reads are deliberately still allowed while paused — a phase that can read
 * can write a coherent summary of where it got to, which is what you want
 * from an interrupted run. Only side effects are denied.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

try {
  const data = C.readInput();
  const tool = data.tool_name || '';

  const paused = C.pauseFile();
  if (paused && C.isSideEffect(tool)) {
    C.event('denied_paused', { tool, file: paused.file });
    C.deny(
      `Oneshot is paused (state/${paused.file}). Side-effectful tools are denied. ` +
      (paused.human
        ? 'A human set this switch; it will not clear on its own. '
        : 'This is a machine-set park that clears itself. ') +
      'Do not retry. Stop now and write a short summary of what you completed ' +
      'and what remains — anything you already wrote to disk is the handoff.',
    );
  }

  // A GitLab call into a network partition burns the phase's whole wall-clock
  // budget for nothing. Reads included: a read that cannot answer is not
  // cheaper than a write that cannot land.
  if (tool.startsWith('mcp__gitlab') && C.networkPaused()) {
    C.event('denied_network', { tool });
    C.deny(
      'GitLab is unreachable — the VPN tunnel is down and the network breaker is open. ' +
      'Every GitLab call is denied until it recovers. Retrying will not help. ' +
      'Finish any local work you can, then stop and say plainly that GitLab was unreachable.',
    );
  }
} catch (err) {
  C.logFailure('pause-check', err);
}

C.allow();
