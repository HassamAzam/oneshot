import { projectConfig } from '../lib/config.js';

export interface Ticket {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  notes?: string[];
  /** Files attached in the description or a comment, downloaded to the run dir. */
  documents?: TicketDoc[];
  /** Document links that point outside GitLab (Google Docs, SharePoint, …). */
  externalDocs?: Array<{ url: string; where: string }>;
}

export interface TicketDoc {
  name: string;
  /** "description" or "comment N", numbered as the prompt numbers comments. */
  where: string;
  /** Absolute path of the downloaded original. Absent when the download failed. */
  path?: string;
  /** A plain-text extraction, for formats the Read tool cannot open itself. */
  textPath?: string;
  /** Why this one could not be downloaded or converted. */
  error?: string;
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

export interface DesignScreen {
  id: string;
  name: string;
  purpose: string;
  states: string[];
  /** Mockup HTML, relative to the run's artifact dir. */
  mockupHtml: string;
  /** Render of that mockup, relative to the artifact dir. */
  screenshot: string;
  /** The same screen as it looks today, or empty when the screen is new. */
  before: string;
  /** The one design decision on this screen worth a reviewer's attention. */
  note: string;
}

export interface DesignArtifact {
  /**
   * False when the ticket has no UI surface to design — someone labelled
   * optimistically, or it turned out backend-only. The gate then never arms
   * and the run carries on to `plan`, the same way an inconclusive bug
   * reproduction carries on rather than blocking. A mislabelled ticket should
   * not cost a person.
   */
  applicable: boolean;
  rationale: string;
  /** More than one screen, or a new step in an existing journey. */
  flowChange: boolean;
  tokensFile: string;
  screens: DesignScreen[];
  /** Present only when `flowChange`; both paths are artifact-relative. */
  prototype: { entry: string; video: string } | null;
  decisions: string[];
  /** Anything not already in the design system, surfaced rather than smuggled in. */
  newPatterns: string[];
  openQuestions: Array<{ q: string; recommendation: string }>;
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
