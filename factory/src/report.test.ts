import { afterEach, describe, expect, it } from 'vitest'
import { prUrl } from './env.ts'
import { targetStatus } from './report.ts'
import { STATUS_TRANSITIONS, type Result } from './schema.ts'
import { slugify, branchName } from './branch.ts'

function result(over: Partial<Result> = {}): Result {
  return {
    status: 'ready_for_review',
    summary: 'Wrote the design.',
    context: '',
    acceptance_criteria: [],
    out_of_scope: [],
    answers: [],
    artifacts: [],
    questions: [],
    assumptions: [],
    reason: '',
    ...over,
  }
}

describe('prUrl', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('builds the URL from the repository it is running in', () => {
    process.env['GITHUB_REPOSITORY'] = 'LukeFerris/dark-factory-playground'
    delete process.env['GITHUB_SERVER_URL']
    expect(prUrl(8)).toBe('https://github.com/LukeFerris/dark-factory-playground/pull/8')
  })

  it('honours a self-hosted server URL', () => {
    process.env['GITHUB_REPOSITORY'] = 'acme/widgets'
    process.env['GITHUB_SERVER_URL'] = 'https://ghe.acme.internal'
    expect(prUrl(3)).toBe('https://ghe.acme.internal/acme/widgets/pull/3')
  })

  it('returns null when there is no PR yet, or no repository to build one from', () => {
    process.env['GITHUB_REPOSITORY'] = 'acme/widgets'
    expect(prUrl(null)).toBeNull()
    delete process.env['GITHUB_REPOSITORY']
    expect(prUrl(8)).toBeNull()
  })
})

describe('status -> Jira status mapping', () => {
  it('sends a finished design to Design review and a finished build to In review', () => {
    expect(targetStatus('design', result({ status: 'ready_for_review' }))).toBe('Design review')
    expect(targetStatus('build', result({ status: 'ready_for_review' }))).toBe('In review')
  })

  it('routes blocked and question to the stage-appropriate blocked status', () => {
    expect(targetStatus('design', result({ status: 'blocked' }))).toBe('Blocked on architect')
    expect(targetStatus('build', result({ status: 'question' }))).toBe('Blocked on engineer')
  })

  it('leaves the card alone on continue', () => {
    expect(targetStatus('build', result({ status: 'continue' }))).toBeNull()
  })

  it('covers every result status for both stages', () => {
    for (const stage of ['design', 'build'] as const) {
      for (const status of Object.keys(STATUS_TRANSITIONS[stage])) {
        expect(STATUS_TRANSITIONS[stage]).toHaveProperty(status)
      }
    }
  })
})

describe('branch naming', () => {
  it('slugifies a card summary', () => {
    expect(slugify('Let the user type their name!')).toBe('let-the-user-type-their-name')
  })

  it('truncates without leaving a trailing dash', () => {
    expect(slugify('a'.repeat(60))).toHaveLength(48)
    expect(slugify('word '.repeat(30)).endsWith('-')).toBe(false)
  })

  // The stage used to be in here, which gave a card two branches and two pull
  // requests. One branch per card is what puts the design document in the
  // build turn's tree without anything having to merge it to main first.
  it('names the branch after the card, not the stage', () => {
    expect(branchName('DF-1', 'Type a name')).toBe('card/DF-1-type-a-name')
  })
})
