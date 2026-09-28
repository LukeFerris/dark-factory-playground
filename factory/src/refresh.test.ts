import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type * as jira from './jira.ts'
import { REPO_ROOT } from './env.ts'
import { ghRunner, setRunner, type Runner } from './github.ts'
import type { MergeState } from './merge.ts'
import {
  handOverComment,
  refreshTargets,
  refreshedComment,
  refusedComment,
  type Trigger,
} from './refresh.ts'

/**
 * The half of the fan-out that does not drive git.
 *
 * `refresh` itself merges, runs four npm scripts and pushes, all against the
 * checkout it is running in — there is no seam to test it through that would not
 * be a re-implementation of git. What is here instead is the two things that
 * decide whether the fan-out is useful: which cards it picks up, and what the
 * person who gets the comment actually reads.
 */

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'bot@example.com', token: 'token' }

const server = setupServer()
const previousRepo = process.env['GITHUB_REPOSITORY']

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
  process.env['GITHUB_REPOSITORY'] = 'acme/dark-factory-playground'
})
afterEach(() => {
  server.resetHandlers()
  setRunner(ghRunner)
})
afterAll(() => {
  server.close()
  if (previousRepo === undefined) delete process.env['GITHUB_REPOSITORY']
  else process.env['GITHUB_REPOSITORY'] = previousRepo
})

/** Walks an ADF tree collecting every text node, so assertions read plainly. */
function textOf(node: unknown): string {
  if (node === null || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  const own = typeof n['text'] === 'string' ? (n['text'] as string) : ''
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return own + kids.map(textOf).join(' ')
}

/** Answers the one JQL search `refreshTargets` makes with these cards. */
function board(keys: string[]): void {
  server.use(
    http.post(`${BASE}/rest/api/3/search/jql`, () =>
      HttpResponse.json({
        issues: keys.map((key) => ({ key, fields: { summary: `${key} does a thing` } })),
      }),
    ),
  )
}

/** Stands in for `gh pr list`, which is the only gh call these paths make. */
function prs(open: Array<{ number: number; headRefName: string }>): Runner {
  const stub: Runner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      const body = open.map((pr) => ({
        ...pr,
        url: `https://github.com/acme/dark-factory-playground/pull/${pr.number}`,
        body: '',
        isDraft: false,
        headRefOid: 'deadbeef',
      }))
      return { status: 0, stdout: JSON.stringify(body), stderr: '' }
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  setRunner(stub)
  return stub
}

describe('choosing which cards a merge invalidated', () => {
  it('pairs every card in review with its open pull request', async () => {
    board(['DF-4', 'DF-5'])
    prs([
      { number: 16, headRefName: 'card/DF-4-let-the-user-type-their-name' },
      { number: 19, headRefName: 'card/DF-5-add-a-greeting' },
    ])

    expect(await refreshTargets(cfg, 'DF')).toEqual([
      { key: 'DF-4', pr: 16, branch: 'card/DF-4-let-the-user-type-their-name' },
      { key: 'DF-5', pr: 19, branch: 'card/DF-5-add-a-greeting' },
    ])
  })

  // The card that just merged is still "In review" on the board for as long as
  // it takes `publish` to move it, and refreshing a branch that has already
  // landed would merge main into itself and comment about it.
  it('leaves out the card whose merge started all this', async () => {
    board(['DF-4', 'DF-7'])
    prs([
      { number: 16, headRefName: 'card/DF-4-let-the-user-type-their-name' },
      { number: 21, headRefName: 'card/DF-7-paint-it-blue' },
    ])

    const targets = await refreshTargets(cfg, 'DF', ['DF-7'])
    expect(targets.map((t) => t.key)).toEqual(['DF-4'])
  })

  // A card mid-teardown, or one somebody moved by hand. One such card must not
  // take the whole fan-out down with it.
  it('skips a card with no open pull request rather than failing', async () => {
    board(['DF-4', 'DF-9'])
    prs([{ number: 16, headRefName: 'card/DF-4-let-the-user-type-their-name' }])

    const targets = await refreshTargets(cfg, 'DF')
    expect(targets.map((t) => t.key)).toEqual(['DF-4'])
  })

  // Branch names start `card/DF-4-`, so a bare `startsWith('card/DF-4')` would
  // hand DF-4's refresh the DF-41 branch.
  it('does not mistake DF-41’s branch for DF-4’s', async () => {
    board(['DF-4'])
    prs([{ number: 60, headRefName: 'card/DF-41-something-else' }])

    expect(await refreshTargets(cfg, 'DF')).toEqual([])
  })
})

const because: Trigger = { number: 21, title: 'Paint the background blue' }

const state = (over: Partial<MergeState> = {}): MergeState => ({
  branch: 'card/DF-5-add-a-greeting',
  state: 'merged',
  behind: 2,
  conflicts: [],
  denied: [],
  before: 'a'.repeat(40),
  main: 'b'.repeat(40),
  incoming: [],
  ...over,
})

describe('what the card says when the refresh worked', () => {
  const body = (): string => textOf(refreshedComment(because, state(), 19, null))

  it('opens with the words the reviewer needs and names the cause', () => {
    expect(body()).toContain('Main has changed.')
    expect(body()).toContain('Paint the background blue merged as PR #21')
  })

  // The ruleset on main has dismiss_stale_reviews_on_push, so the push this
  // comment is announcing has silently thrown away yesterday's approval.
  it('warns that the approval is gone', () => {
    expect(body()).toContain('dismisses any approval')
  })

  it('says the checks were run, because that is the claim being made', () => {
    expect(body()).toContain('2 commit(s) came across')
    expect(body()).toContain('lint, typecheck, tests and build all still pass')
  })
})

describe('what the card says when it is going back to Building', () => {
  const body = (reason: string): string => textOf(handOverComment(because, reason, 19, null))

  it('gives the specific reason, not just that something went wrong', () => {
    expect(body('Merging main into this branch conflicts in app/src/index.css.')).toContain(
      'conflicts in app/src/index.css',
    )
  })

  // Nobody is being asked anything yet: the build agent usually resolves it and
  // the card comes straight back. A comment shaped like a question here would
  // train people to ignore the one that really is a question.
  it('reassures rather than asks, and promises to come back if it must', () => {
    const text = body('`npm run build` fails on the merged result.')
    expect(text).toContain('Nothing has been pushed')
    expect(text).toContain('the agent will ask here')
    expect(text).not.toContain('?')
  })
})

describe('what the card says when no agent may touch the conflict', () => {
  it('names the machinery and asks for a person, with no promise of a retry', () => {
    const text = textOf(
      refusedComment(because, state({ state: 'refused', denied: ['factory/src/validate.ts'] }), 19, null),
    )

    expect(text).toContain('factory/src/validate.ts')
    expect(text).toContain('Someone needs to merge main into the branch by hand')
    expect(text).not.toContain('going back to Building')
  })
})

/**
 * The trigger lives in YAML, where none of the tests above can see it, and it
 * is the half that actually decides whether a refresh ever happens. DF-9 sat
 * in review through three merges to main with an approval on it and a merge
 * button that would not go, because the fan-out only fired for `card/`
 * branches.
 */
describe('the refresh trigger', () => {
  const yaml = readFileSync(resolve(REPO_ROOT, '.github/workflows/refresh.yml'), 'utf8')

  it('fans out on any merge to main, not only a card branch', () => {
    expect(yaml).not.toContain("startsWith(github.event.pull_request.head.ref, 'card/')")
    expect(yaml).toContain('github.event.pull_request.merged == true')
  })

  // The hand-operated way back in when something does not fire on its own.
  it('can still be dispatched by hand', () => {
    expect(yaml).toContain("github.event_name == 'workflow_dispatch'")
  })
})
