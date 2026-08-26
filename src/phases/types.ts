import { projectConfig } from '../lib/config.js';

export interface Ticket {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  notes?: string[];
}

/**
 * Read-side mirrors of the handoff schemas in src/conductor/schemas.ts.
 *
 * Prompt builders SLICE named fields out of prior artifacts rather than
 * stringifying them, so every builder needs the shape of the thing it slices.
 * Declaring those shapes once, here, is what stops each new builder inventing
 * its own slightly different inline type — and a drifted inline type fails
 * silently, by rendering an empty block into a prompt that nobody reads twice.
 *
 * These are structural mirrors and never the source of truth: the schemas are
 * what the SDK enforces, and they win. Anything optional here is optional
 * because a prior phase may have been skipped, not because the schema allows
 * its absence.
 */
export interface TestCase {
  id: string;
  scenario: string;
  precondition: string;
  steps: string[];
  expected: string;
  pass: string[];
  blast: 'high' | 'medium' | 'low';
}

export interface CaseResult {
  id: string;
  result: 'pass' | 'fail' | 'blocked' | 'skipped';
  evidence: string;
  screenshot: string;
}

export interface Finding {
  id: string;
  severity: 'blocker' | 'major' | 'minor' | 'suggestion';
  file: string;
  line: number;
  what: string;
  why: string;
  fix: string;
}

export interface Screenshot {
  file: string;
  caption: string;
  caseId: string;
}

export function GITLAB_PROJECT_URL(): string {
  const c = projectConfig();
  return `https://${c.gitlab.host}/${c.gitlab.project}`;
}
