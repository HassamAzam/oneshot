/**
 * The diagnosis session's handoff, enforced by the SDK like every phase's.
 *
 * Kept flat and small on purpose. A session that has done its work and then
 * cannot serialise it is the failure this whole feature was built to explain
 * (ticket 9174 lost two finished laps to it), so nothing here is nested deeper
 * than a finding and its citations, and nothing is required that a finished
 * diagnosis would not have anyway.
 *
 * `evidence` is the field with teeth. Each citation is checked by code after
 * the session ends (src/diagnosis/citations.ts): the file has to exist, and the
 * quote has to be in it. A finding none of whose citations check out is shown
 * as a lead, not a finding, and never gets a fix opened for it.
 */
import type { JsonSchema } from '../conductor/schemas.js';
import { CATEGORIES, CONFIDENCE, FIX_BY } from './types.js';

const str = (description: string) => ({ type: 'string', description });

export const DIAGNOSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: str('One or two sentences for the conductor log. No markdown.'),
    blocked: {
      type: ['string', 'null'],
      description: 'Set ONLY when you could not diagnose at all: the run directory is unreadable or empty. Otherwise omit it.',
    },
    headline: str(
      'One sentence, at most 200 characters, for someone who has not read the ticket: where the run went wrong. '
      + 'Name the cause, not the phase that reported it.',
    ),
    account: str(
      'The causal story in order, two to five short paragraphs: what happened, what each failure led to, and why the run '
      + 'ended where it did. Refer to findings by id. Plain prose, no headings.',
    ),
    findings: {
      type: 'array',
      description: 'One per distinct CAUSE, not per failed attempt: six laps that died of one thing are one finding. Most important first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: str('D-1, D-2, … in the order listed. Exactly that shape.'),
          title: str('The cause in under 90 characters.'),
          category: {
            type: 'string',
            enum: [...CATEGORIES],
            description:
              "'harness' = a defect in Oneshot's own code, config, prompts, hooks or skills. "
              + "'environment' = this machine, an account, a credential, a service or the network. "
              + "'ticket' = the ticket's own change is wrong or unfinished. "
              + "'human' = nothing is broken; a decision is owed that only a person can make.",
          },
          phases: str('The attempts this explains, e.g. "verify laps 0-5, ui-evidence lap 0".'),
          recorded: str("What the journal recorded for those attempts, quoted, when it differs from the cause. '' when it was accurate."),
          cause: str('What actually happened, and how it produced what was recorded.'),
          evidence: {
            type: 'array',
            minItems: 1,
            description:
              'Where this can be seen. Each entry is checked by code: the file must exist and the quote must appear in it. '
              + 'A finding with no entry that checks out is demoted to a lead.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: str(
                  'Path relative to the run directory (transcripts/verify-lap3.jsonl, run.json, findings.json, '
                  + 'diagnosis/evidence.json), or repo:<path> for a source file of the Oneshot repository '
                  + '(repo:src/conductor/phase.ts). Never your own output or transcripts.',
                ),
                line: { type: 'integer', description: 'Line number in that file. For a transcript, the frame\'s line.' },
                quote: str(
                  'Text copied verbatim from that line, 12 to 300 characters. To leave out the middle use … at most twice, '
                  + 'keeping parts of at least 12 characters each, all from that one line.',
                ),
              },
              required: ['file', 'line', 'quote'],
            },
          },
          solution: str('What to implement or do, specific enough to act on without this conversation.'),
          where: {
            type: 'array',
            items: { type: 'string' },
            description: 'The files or places the fix goes: repo paths for harness, the host and setting for environment, the work repo\'s paths for ticket.',
          },
          fix: {
            type: 'string',
            enum: [...FIX_BY],
            description:
              "'pr' = a code change to the Oneshot repository that STILL HAS TO BE WRITTEN. 'operator' = someone changes the "
              + "machine or an account, which includes deploying code that already has the fix. 'pipeline' = the run goes back "
              + "through a phase. 'person' = someone decides.",
          },
          fixedBy: str(
            "The commit in this checkout that already fixes this cause, as a short SHA you found with `git log`. '' when there "
            + "is none. When you set it, `fix` is 'operator' (run code that has the commit), never 'pr'.",
          ),
          confidence: {
            type: 'string',
            enum: [...CONFIDENCE],
            description: "'confirmed' only when the evidence shows the cause itself, not merely something consistent with it.",
          },
        },
        required: ['id', 'title', 'category', 'phases', 'recorded', 'cause', 'evidence', 'solution', 'where', 'fix', 'fixedBy', 'confidence'],
      },
    },
    decisive: str("The id of the finding that actually stopped the run: the one to fix first. '' when there are no findings."),
    nextStep: str(
      'The single next action for a person, written for someone with none of this context: what to do, where, and what it releases. '
      + '"Investigate the failure" is not an action.',
    ),
    resumeFrom: str("The phase the run should resume from once that is done, or '' when it should not resume."),
  },
  required: ['summary', 'headline', 'account', 'findings', 'decisive', 'nextStep', 'resumeFrom'],
};
