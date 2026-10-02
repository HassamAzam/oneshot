/**
 * Shapes of the Ready For Automation mode's authored output.
 *
 * Type-only, so the pure modules that read a saved version (comments.ts, the
 * runner's state machine, the sheet writer's `SheetCase`) can share one
 * definition without loading anything.
 *
 * These mirror AUTOMATION_TESTCASES_SCHEMA in src/conductor/schemas.ts. The
 * schema is what the SDK enforces and it wins; this is the read side, and a
 * field added there without being added here is caught by `tsc` at the first
 * place that reads it.
 */

/**
 * Whether Cypress can carry the case on its own.
 *
 * Three values rather than a boolean because the middle one is the common
 * honest answer: the form can be driven and the toast asserted, but the PDF it
 * produces still needs a person. Collapsing that to `yes` over-promises the
 * suite; collapsing it to `no` throws away the part that could be automated.
 */
export type Automatable = 'yes' | 'partly' | 'no';

export interface AutomationCase {
  /** TC-01, TC-02, … Stable across revisions: a revised case keeps its id, a removed one is never reused. */
  id: string;
  /** Starts with 'Verify that'. */
  scenario: string;
  /** The data, role and page that must exist first. '' when none. */
  precondition: string;
  /** UI actions in order, one per element, unnumbered: the note and the CSV number them. */
  steps: string[];
  /** The one observable result that decides pass or fail. */
  expected: string;
  automatable: Automatable;
  /** Why it is yes, partly or no. For partly or no it names the limit. Never empty. */
  reason: string;
}

export interface AutomationArtifact {
  summary: string;
  blocked?: string | null;
  /** The sheet module, spelt like an existing module tab when one fits. */
  module: string;
  cases: AutomationCase[];
  /** REVISE: one entry per change, plus 'Not applied: … — why'. [] on WRITE. */
  changes: string[];
  /** What the session actually read, e.g. '!501 apps/profile/views.py' (an invented number). */
  sources: string[];
}
