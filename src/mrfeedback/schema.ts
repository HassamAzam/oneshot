/** JSON-schema fragments; src/conductor/schemas.ts wraps them in its phaseSchema(). */

const str = (description: string) => ({ type: 'string', description });

export const ADDRESSED_FEEDBACK_PROP = {
  type: 'array',
  description: 'MR review items (MRF-01, …) this lap fixed. Empty when the prompt lists no MR review comments to fix.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: str('The MRF id exactly as the prompt gave it'),
      note: str('One line for the reviewer saying what changed. Posted as the reply on their thread.'),
    },
    required: ['id', 'note'],
  },
} as const;

export const MR_FEEDBACK_PROPS = {
  items: {
    type: 'array',
    description: 'At least one item per thread shown; one item per distinct request.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: str('Any id; the conductor renumbers to MRF-01…'),
        discussionId: str('The discussion id exactly as shown'),
        disposition: { type: 'string', enum: ['fix', 'question', 'decline', 'already-done'] },
        request: str('What the reviewer asks for, in one sentence'),
        plan: str("For fix: what to change and where. '' otherwise."),
        reply: str("For question, decline, already-done: the reply to post, citing file:line. '' for fix."),
      },
      required: ['id', 'discussionId', 'disposition', 'request', 'plan', 'reply'],
    },
  },
} as const;
