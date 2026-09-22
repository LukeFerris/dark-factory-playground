import { z } from 'zod'

/**
 * The result contract.
 *
 * Every agent turn — design or build — ends by writing `.agent/out/result.json`
 * matching this shape. It is the ONLY channel by which the agent tells the
 * factory what happened; the transcript is for humans, not for control flow.
 *
 * `blocked` is the design-stage name for "a human must answer something before
 * I can continue"; `question` is the build-stage name for the same condition.
 * Keeping them distinct lets `report` map each to the right Jira status without
 * needing to know which stage it is in.
 */
export const ResultStatus = z.enum([
  'ready_for_review',
  'blocked',
  'continue',
  'question',
  'failed',
])
export type ResultStatus = z.infer<typeof ResultStatus>

export const QuestionSchema = z.object({
  question: z.string().min(1),
  context: z.string().default(''),
  options: z.array(z.string()).default([]),
})
export type Question = z.infer<typeof QuestionSchema>

export const ResultSchema = z.object({
  status: ResultStatus,
  /** One line of "what I did", then optional detail. Required in every case. */
  summary: z.string().min(1),
  /** Background for the card comment: why this shape, and what to read next. */
  context: z.string().default(''),
  /**
   * How a human checks the card worked: the steps they take in the browser,
   * in order, with the app already open.
   *
   * Required when `status` is `ready_for_review`. That rule lives in
   * `validate`, not here, because zod cannot express it without making the
   * whole parse conditional — and `validate` is where a broken contract turns
   * into a Jira comment a human can read rather than a stack trace.
   */
  acceptance_criteria: z.array(z.string()).default([]),
  /** Repo-relative paths the turn produced or changed. */
  artifacts: z.array(z.string()).default([]),
  /** Populated when status is `blocked` or `question`. */
  questions: z.array(QuestionSchema).default([]),
  /** Decisions the agent took unilaterally; surfaced on the PR and the card. */
  assumptions: z.array(z.string()).default([]),
  /** Populated when status is `failed`. */
  reason: z.string().default(''),
})
export type Result = z.infer<typeof ResultSchema>

/** Stages the pipeline runs. */
export const Stage = z.enum(['design', 'build'])
export type Stage = z.infer<typeof Stage>

/**
 * What each stage is allowed to write.
 *
 * `validate` diffs the branch against origin/main and rejects anything outside
 * this list. The deny list below is not strictly necessary — anything not
 * matched here is already rejected — but it is spelled out so the intent is
 * legible to a human reading the file, and so a careless widening of the allow
 * list still trips over it.
 */
export const ALLOWED_PATHS: Record<Stage, readonly string[]> = {
  design: ['docs/design/**', 'docs/adr/**'],
  build: [
    'app/src/**',
    'app/public/**',
    'app/index.html',
    'app/package.json',
    'package-lock.json',
    'docs/design/*/build-log.md',
    '.preview/env.yaml',
  ],
}

/** Never writable by any stage, whatever the allow list says. */
export const ALWAYS_DENIED: readonly string[] = [
  '.github/**',
  '.agent/**',
  'factory/**',
  'bootstrap/**',
  'package.json',
  'tsconfig*.json',
  'app/tsconfig.json',
  'app/eslint.config.js',
  'app/vite.config.ts',
  'factory/tsconfig.json',
]

/**
 * status -> the Jira status `report` moves the card to, per stage.
 * `null` means "leave the card where it is" (a `continue` build turn has not
 * finished anything; the card stays in Build in progress).
 */
export const STATUS_TRANSITIONS: Record<Stage, Record<ResultStatus, string | null>> = {
  design: {
    ready_for_review: 'Design review',
    blocked: 'Blocked on architect',
    question: 'Blocked on architect',
    continue: null,
    failed: 'Blocked on architect',
  },
  build: {
    ready_for_review: 'In review',
    blocked: 'Blocked on engineer',
    question: 'Blocked on engineer',
    continue: null,
    failed: 'Blocked on engineer',
  },
}

/** JSON Schema emitted to .agent/result.schema.json, hand-written from the zod above. */
export function toJsonSchema(): unknown {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://dark-factory.local/result.schema.json',
    title: 'Factory agent turn result',
    description:
      'Written by the agent to .agent/out/result.json at the end of every design or build turn.',
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary'],
    properties: {
      status: {
        enum: ResultStatus.options,
        description:
          'ready_for_review: the turn finished the work. blocked (design) / question (build): a human must answer before continuing. continue: more turns needed. failed: the turn could not complete.',
      },
      summary: {
        type: 'string',
        minLength: 1,
        description: 'First line becomes the commit message subject. Always required.',
      },
      context: {
        type: 'string',
        default: '',
        description:
          'One or two lines of background for the Jira comment: why this shape, and where to read the detail. Not a restatement of summary.',
      },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'The exact steps a person takes in the browser, with the app already open, to check this card worked. One step per entry, in order, naming what is on screen. Required when status is ready_for_review.',
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Repo-relative paths this turn produced or changed.',
      },
      questions: {
        type: 'array',
        default: [],
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1 },
            context: { type: 'string', default: '' },
            options: { type: 'array', items: { type: 'string' }, default: [] },
          },
        },
        description: 'Required when status is blocked or question.',
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Decisions taken without asking. Surfaced on the PR and the Jira card.',
      },
      reason: {
        type: 'string',
        default: '',
        description: 'Required when status is failed.',
      },
    },
  }
}
