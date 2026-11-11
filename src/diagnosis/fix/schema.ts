/**
 * Handoffs of the three fix sessions: the author, a reviewer and the verifier.
 *
 * `outcome: 'refused'` is a first-class answer for the author, and the schema
 * makes it as easy to give as a fix. An author that can only succeed will
 * produce a change for a defect it could not reproduce.
 */
import type { JsonSchema } from '../../conductor/schemas.js';

const str = (description: string) => ({ type: 'string', description });
const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const COMMON = {
  summary: str('One or two sentences for the conductor log. No markdown.'),
  blocked: {
    type: ['string', 'null'],
    description: 'Set ONLY when you could not do the job at all and no retry would help. Otherwise omit it.',
  },
} as const;

const point = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: {
      type: 'string',
      enum: ['blocker', 'nit', 'note'],
      description:
        "'blocker' = it is wrong, it breaks an invariant, or it ships something unproven. 'nit' = real, not blocking. "
        + "'note' = an observation, not a request.",
    },
    file: str("The file it is about, relative to the repository root. '' when it is about the change as a whole."),
    line: { type: 'integer', description: 'The line, or 0.' },
    what: str('The point, in one or two sentences.'),
    why: str('What goes wrong because of it, concretely: the input, the path, the result.'),
    fix: str("What would resolve it. '' for a note."),
  },
  required: ['severity', 'file', 'line', 'what', 'why', 'fix'],
} as const;

export const FIX_AUTHOR_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COMMON,
    outcome: {
      type: 'string',
      enum: ['fixed', 'refused'],
      description: "'fixed' = the change is committed on the branch with its test. 'refused' = no unattended change should be made; say why in `refusal`.",
    },
    refusal: str(
      "Why no fix was made, when `outcome` is 'refused': it does not reproduce on this branch, it is already fixed here, the "
      + "code it concerns is not on this branch, it needs a design or cost decision, or it needs a test pattern this suite does "
      + "not use. '' when fixed.",
    ),
    reproduced: {
      type: 'boolean',
      description: 'True only if you wrote a test, ran it BEFORE the fix, and watched it fail for the diagnosed reason.',
    },
    title: str(
      'The pull request title: a plain summary of what the change does, under 70 characters. No `fix:` prefix and no ticket '
      + 'number (those belong in commit subjects). Put names from the code in backticks.',
    ),
    prSummary: str('For a PUBLIC pull request: what the change does, two to five sentences or bullets. No ticket text, no names, no hosts, no paths outside this repository.'),
    prWhy: str('For a PUBLIC pull request: the mechanism of the defect with file:line in this repository, and what it caused. Refer to the run only as the ticket number you were given.'),
    prTests: str('For a PUBLIC pull request: what the new or changed tests pin, by test name.'),
    testFiles: strArr('Test files you added or changed, relative to the repository root.'),
    commits: strArr('The commits you made on the branch, as short SHAs.'),
    addressed: {
      type: 'array',
      description: 'On a fix round: one entry per point you were sent, and what you did about it. Empty on the first lap.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: str('The point\'s id, as given.'), how: str('What you changed, or why the point does not hold.') },
        required: ['id', 'how'],
      },
    },
  },
  required: ['summary', 'outcome', 'refusal', 'reproduced', 'title', 'prSummary', 'prWhy', 'prTests', 'testFiles', 'commits', 'addressed'],
};

export const FIX_REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COMMON,
    verdict: { type: 'string', enum: ['approve', 'approve-with-nits', 'request-changes'], description: 'request-changes only when there is a blocker.' },
    verified: str('What you verified yourself, and how: the commands you ran and what they printed.'),
    findings: { type: 'array', description: 'Every point, most severe first. Empty is a complete answer.', items: point },
  },
  required: ['summary', 'verdict', 'verified', 'findings'],
};

export const FIX_VERIFY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COMMON,
    rulings: {
      type: 'array',
      description: 'One per blocker you were given, by its id. A blocker you do not rule on is treated as upheld.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: str('The point\'s id, as given.'),
          holds: { type: 'boolean', description: 'True when you tried to refute it and could not.' },
          reason: str('What you did to test it and what you saw.'),
        },
        required: ['id', 'holds', 'reason'],
      },
    },
    additional: { type: 'array', description: 'Blockers the reviewers missed that you found while verifying. Usually empty.', items: point },
    fixesTheCause: {
      type: 'boolean',
      description: 'True only if you confirmed for yourself that the change removes the diagnosed cause, not merely that its tests pass.',
    },
    verdict: {
      type: 'string',
      enum: ['ship', 'fix-first', 'do-not-ship'],
      description: "'ship' = no upheld blocker and the cause is fixed. 'fix-first' = upheld blockers the author can answer. 'do-not-ship' = this change should not be opened at all; say why in `reason`.",
    },
    reason: str('The reason for the verdict, in two or three sentences.'),
  },
  required: ['summary', 'rulings', 'additional', 'fixesTheCause', 'verdict', 'reason'],
};
