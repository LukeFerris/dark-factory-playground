import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { gather } from './gather.ts'
import { ghRunner, setRunner, type Runner } from './github.ts'
import { TASK_PATH } from './meta.ts'

const BASE = 'https://example.atlassian.net'
const BOT = 'bot-account-id'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  process.env['JIRA_BASE'] = BASE
  process.env['JIRA_USER'] = 'bot@example.com'
  process.env['JIRA_TOKEN'] = 'token'
})

interface Said {
  who: string
  id: string
  body: string
}

/** Stands up the four endpoints `gather` reads, with a given conversation. */
function card(said: Said[]): void {
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: BOT })),
    http.get(`${BASE}/rest/api/3/field`, () => HttpResponse.json([])),
    http.get(`${BASE}/rest/api/3/issue/DF-1`, () =>
      HttpResponse.json({ key: 'DF-1', fields: { summary: 'Do the thing' } }),
    ),
    http.get(`${BASE}/rest/api/3/issue/DF-1/comment`, () =>
      HttpResponse.json({
        comments: said.map((s) => ({
          id: s.id,
          author: { displayName: s.who === BOT ? 'Factory' : 'A human', accountId: s.who },
          created: '2026-09-26T10:00:00.000+0000',
          body: { type: 'doc', version: 1, content: [{ type: 'text', text: s.body }] },
        })),
      }),
    ),
  )
}

/**
 * A design card's round number is counted from the factory's own comments on
 * it — nothing stores a counter, so a card cannot disagree with itself about
 * how many turns it has had. That makes the count load-bearing, and it made
 * adding a second factory comment per turn a silent way to break it.
 */
describe('which of the factory’s own comments count as a turn', () => {
  it('counts a finished turn and ignores the ping that started it', async () => {
    card([
      { who: 'human-1', id: '1', body: 'Please centre the content.' },
      { who: BOT, id: '2', body: 'design turn 1 started' },
      { who: BOT, id: '3', body: 'design turn paused — needs an answer' },
      { who: 'human-1', id: '4', body: 'Yes, centre it horizontally only.' },
    ])

    const meta = await gather({ key: 'DF-1', stage: 'design' })

    // One finished design turn, so this is the second — not the third.
    expect(meta.turn).toBe(2)
    expect(readFileSync(TASK_PATH, 'utf8')).toContain('This is design turn 2.')
  })

  /**
   * The ping is addressed to whoever is watching the card. Putting "nothing is
   * expected of you while this runs" in front of the agent that is running is
   * worse than noise — it reads as an instruction.
   */
  it('keeps the start ping out of the agent’s task file', async () => {
    card([
      { who: BOT, id: '1', body: 'build turn 2 started' },
      { who: BOT, id: '2', body: 'build turn finished — ready for review' },
      { who: 'human-1', id: '3', body: 'Looks good, one change please.' },
    ])

    await gather({ key: 'DF-1', stage: 'design' })
    const task = readFileSync(TASK_PATH, 'utf8')

    expect(task).not.toContain('turn 2 started')
    expect(task).toContain('ready for review')
    expect(task).toContain('one change please')
  })

  /** A human who happens to write about starting is not the factory. */
  it('only discounts the factory’s own pings', async () => {
    card([
      { who: 'human-1', id: '1', body: 'design turn 1 started' },
      { who: BOT, id: '2', body: 'design turn paused — needs an answer' },
    ])

    const meta = await gather({ key: 'DF-1', stage: 'design' })
    expect(meta.turn).toBe(2)
    expect(readFileSync(TASK_PATH, 'utf8')).toContain('design turn 1 started')
  })
})

describe('the branch a turn publishes to', () => {
  // build-turn.yml checks the PR branch out and never calls prepare-branch, so
  // gather is the only thing that names the branch publish pushes.
  it('is the branch that is checked out', async () => {
    card([])
    const meta = await gather({ key: 'DF-1', stage: 'build' })
    const current = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
    expect(meta.branch).toBe(current)
  })
})

/** `gh`, for a pull request whose `ci` check ended as given. */
function pullRequest(conclusion: string): void {
  const json = (out: unknown) => ({ status: 0, stdout: JSON.stringify(out), stderr: '' })
  const logs = {
    status: 0,
    stdout: '2026-10-13T10:00:00.0Z FAIL src/app.test.ts > greets Ada\n',
    stderr: '',
  }
  const pr = (field: string) => (args: string[]) => args[0] === 'pr' && args.includes(field)
  const api = (test: (path: string) => boolean) => (args: string[]) => test(args[1] ?? '')
  // The first that matches answers, so the more specific paths come first.
  const answers: Array<[(args: string[]) => boolean, ReturnType<Runner>]> = [
    [pr('comments'), json({ comments: [] })],
    [pr('body,headRefName'), json({ body: '', headRefName: 'card/DF-1-x' })],
    [pr('headRefOid'), json({ headRefOid: 'a'.repeat(40) })],
    [
      api((p) => p.endsWith('/rules/branches/main')),
      json([
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
    ],
    [api((p) => p.endsWith('/branches/main')), json({})],
    [
      api((p) => p.includes('/check-runs')),
      json([
        {
          id: 3,
          name: 'ci',
          status: 'completed',
          conclusion,
          html_url: null,
          app: { slug: 'github-actions' },
        },
      ]),
    ],
    [api((p) => p.includes('/status')), json([])],
    [api((p) => p.endsWith('/actions/jobs/3/logs')), logs],
  ]
  const runner: Runner = (args) =>
    answers.find(([matches]) => matches(args))?.[1] ?? {
      status: 1,
      stdout: '',
      stderr: `unexpected: ${args.join(' ')}`,
    }
  setRunner(runner)
}

describe('a build turn on a pull request whose required checks fail', () => {
  const repository = process.env['GITHUB_REPOSITORY']
  beforeEach(() => {
    process.env['GITHUB_REPOSITORY'] = 'o/r'
  })
  afterEach(() => {
    setRunner(ghRunner)
    if (repository === undefined) delete process.env['GITHUB_REPOSITORY']
    else process.env['GITHUB_REPOSITORY'] = repository
  })

  it('tells the agent what failed and that this is an automatic turn', async () => {
    card([])
    pullRequest('failure')
    await gather({ key: 'DF-1', stage: 'build', pr: 5, retry: 1 })
    const task = readFileSync(TASK_PATH, 'utf8')
    expect(task).toContain('## Checks failing on the pull request')
    expect(task).toContain('automatic turn 1 of 2')
    expect(task).toContain('### ci — failure')
    expect(task).toContain('FAIL src/app.test.ts > greets Ada')
  })

  it('says nothing of checks that pass', async () => {
    card([])
    pullRequest('success')
    await gather({ key: 'DF-1', stage: 'build', pr: 5 })
    expect(readFileSync(TASK_PATH, 'utf8')).not.toContain('Checks failing')
  })
})

describe('the job gather runs in', () => {
  // gather reads the failures of the workflows verify dispatches, and of the
  // checks it waits for, from the same variables verify does. Unset, its report
  // covers the required checks alone.
  it('is given what verify waits for', () => {
    const turn = readFileSync(new URL('../../.github/workflows/turn.yml', import.meta.url), 'utf8')
    const prepare = turn.slice(turn.indexOf('\n  prepare:\n'), turn.indexOf('\n  agent:\n'))
    expect(prepare).toContain('FACTORY_VERIFY_WORKFLOWS: ${{ vars.FACTORY_VERIFY_WORKFLOWS }}')
    expect(prepare).toContain('FACTORY_VERIFY_CHECKS: ${{ vars.FACTORY_VERIFY_CHECKS }}')
  })
})
