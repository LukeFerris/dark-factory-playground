import { existsSync, readFileSync } from 'node:fs'
import { changedFiles } from './git.ts'
import { RESULT_PATH, writeFileEnsuringDir } from './meta.ts'
import { ALLOWED_PATHS, ALWAYS_DENIED, ResultSchema, type Result, type Stage } from './schema.ts'

/**
 * Minimal glob matcher for the allow/deny lists.
 *
 * Supports `**` (any number of path segments) and `*` (within one segment).
 * Deliberately not a dependency: the patterns are ours, they are short, and a
 * general-purpose glob library would widen what this security check depends on.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .split('')
    .map((c) => ('\\^$.|?+()[]{}'.includes(c) ? `\\${c}` : c))
    .join('')

  const regex = escaped
    // `/**` at the end also matches the bare directory prefix.
    .replace(/\/\*\*/g, '(?:/.*)?')
    .replace(/\*\*/g, '.*')
    // A single `*` must not cross a path separator.
    .replace(/(?<!\.)\*/g, '[^/]*')

  return new RegExp(`^${regex}$`).test(path)
}

export interface ScopeViolation {
  path: string
  reason: 'denied' | 'not-allowed'
}

export function checkScope(stage: Stage, files: string[]): ScopeViolation[] {
  const allowed = ALLOWED_PATHS[stage]
  const violations: ScopeViolation[] = []

  for (const file of files) {
    if (ALWAYS_DENIED.some((p) => matchesGlob(file, p))) {
      violations.push({ path: file, reason: 'denied' })
      continue
    }
    if (!allowed.some((p) => matchesGlob(file, p))) {
      violations.push({ path: file, reason: 'not-allowed' })
    }
  }
  return violations
}

/**
 * The contract rules the JSON Schema cannot express — each one a relationship
 * between `status` and another field.
 *
 * Pulled out of `validate` so it can be tested without a git repository and a
 * result file on disk, which is the only reason these rules used to go
 * unchecked.
 */
export function contractProblems(result: Result): string[] {
  const problems: string[] = []

  if ((result.status === 'blocked' || result.status === 'question') && result.questions.length === 0) {
    problems.push(`status is "${result.status}" but no questions were given.`)
  }
  if (result.status === 'failed' && result.reason.trim() === '') {
    problems.push('status is "failed" but no reason was given.')
  }
  // Only on a finished turn. A blocked or failed turn has nothing to verify
  // yet, and demanding criteria for work that did not happen would just teach
  // the agent to invent them.
  if (result.status === 'ready_for_review') {
    if (result.acceptance_criteria.length === 0) {
      problems.push(
        'status is "ready_for_review" but acceptance_criteria is empty. A finished turn has to say what is now true.',
      )
    }
    // A criterion nobody can check is a wish. Caught here rather than in the
    // JSON Schema's minItems so the agent gets told which one, by name.
    for (const c of result.acceptance_criteria) {
      if (c.steps.length === 0) {
        problems.push(
          `acceptance criterion "${c.criterion}" has no steps. Every criterion needs the browser steps that prove it.`,
        )
      }
    }
  }

  return problems
}

export interface ValidateOutcome {
  ok: boolean
  result: Result
  violations: ScopeViolation[]
  problems: string[]
}

/**
 * Validates the turn: the result file parses against the contract, and the diff
 * stays inside the stage's allowed paths.
 *
 * On failure it OVERWRITES result.json with a synthetic `failed` result naming
 * the problem, so the `report` step further down the workflow still has
 * something coherent to put on the card. Exiting 4 without doing that would
 * leave the card silently stuck.
 */
export function validate(stage: Stage, base = 'origin/main'): ValidateOutcome {
  const problems: string[] = []
  let result: Result | null = null

  if (!existsSync(RESULT_PATH)) {
    problems.push('The agent did not write .agent/out/result.json.')
  } else {
    try {
      const parsed = ResultSchema.safeParse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
      if (parsed.success) {
        result = parsed.data
      } else {
        problems.push(
          `result.json does not match the contract: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        )
      }
    } catch (error) {
      problems.push(`result.json is not valid JSON: ${(error as Error).message}`)
    }
  }

  if (result !== null) problems.push(...contractProblems(result))

  const violations = checkScope(stage, changedFiles(base))
  for (const v of violations) {
    problems.push(
      v.reason === 'denied'
        ? `${v.path} is never writable by an agent.`
        : `${v.path} is outside the paths a ${stage} turn may write.`,
    )
  }

  if (problems.length === 0 && result !== null) {
    return { ok: true, result, violations, problems }
  }

  const synthetic: Result = {
    status: 'failed',
    summary: `The ${stage} turn was rejected by validation.`,
    context: result?.context ?? '',
    // Carried through rather than dropped: if the agent wrote usable criteria
    // and then strayed outside its paths, they are still the clearest
    // statement of what it was trying to do.
    acceptance_criteria: result?.acceptance_criteria ?? [],
    artifacts: result?.artifacts ?? [],
    questions: result?.questions ?? [],
    assumptions: result?.assumptions ?? [],
    reason: problems.join('\n'),
  }
  writeFileEnsuringDir(RESULT_PATH, `${JSON.stringify(synthetic, null, 2)}\n`)
  return { ok: false, result: synthetic, violations, problems }
}
