import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import type { AdfDoc } from './adf.ts'
import { EVIDENCE_DIR, SLIDES_PATH } from './evidence.ts'
import { RESULT_PATH, writeFileEnsuringDir, writeMeta, type Meta } from './meta.ts'
import type { Result } from './schema.ts'
import { VERIFY_PATH, writeVerdict, type Verdict } from './verify.ts'

/**
 * A Jira that records what `report` does to a card, and the files a finished
 * turn leaves, for the tests that run `report` end to end.
 *
 * Not a test file itself, so the tests that use it are what cover it.
 */

export const BASE = 'https://example.atlassian.net'
export const FACTORY = '712020:factory'
export const HUMAN = '557058:human'
export const ISSUE = `${BASE}/rest/api/3/issue/DF-7`

export const server = setupServer()

/** Everything `report` printed, reset before each test. */
export const logs: string[] = []

/** Stands the fake Jira up around each test, and puts the environment back after. */
export function useReportRun(): void {
  const saved = { ...process.env }
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())
  beforeEach(() => {
    process.env['JIRA_BASE'] = BASE
    process.env['JIRA_USER'] = 'bot@example.com'
    process.env['JIRA_TOKEN'] = 'token'
    process.env['GITHUB_REPOSITORY'] = 'o/r'
    process.env['GITHUB_RUN_ID'] = '99'
    delete process.env['GITHUB_SERVER_URL']
    delete process.env['AZURE_PREVIEW_LAUNCHER']
    rmSync(EVIDENCE_DIR, { recursive: true, force: true })
    rmSync(VERIFY_PATH, { force: true })
    logs.length = 0
    const record = (...args: unknown[]): void => void logs.push(args.join(' '))
    vi.spyOn(console, 'log').mockImplementation(record)
    vi.spyOn(console, 'error').mockImplementation(record)
  })
  afterEach(() => {
    server.resetHandlers()
    vi.restoreAllMocks()
    process.env = { ...saved }
    process.exitCode = undefined
  })
}

/**
 * Writes the files `report` reads: who the turn is, what it produced, and, for
 * a build that finished, a green verdict from `verify`.
 */
export function turn(meta: Partial<Meta>, result: Partial<Result>): void {
  writeMeta({
    key: 'DF-7',
    stage: 'build',
    turn: 1,
    branch: 'card/DF-7-a-thing',
    base_sha: 'abc1234',
    pr: 20,
    preview_url: null,
    ...meta,
  })
  writeFileEnsuringDir(
    RESULT_PATH,
    JSON.stringify({
      status: 'ready_for_review',
      summary: 'Deals can be edited.',
      acceptance_criteria: [{ criterion: 'Edits save.', steps: ['Open a deal.', 'Save it.'] }],
      ...result,
    }),
  )
  verdict('green')
}

/** Leaves the verdict `verify` would have, on the commit the turn pushed. */
export function verdict(outcome: Verdict['outcome']): void {
  const state = outcome === 'green' ? 'pass' : 'fail'
  writeVerdict({
    outcome,
    sha: 'abc1234'.padEnd(40, '0'),
    checks: [{ name: 'ci', state, conclusion: null, url: null }],
    workflows: [],
  })
}

/** Leaves screenshots for the given steps, and the walkthrough if asked. */
export function captured(steps: number[], video: boolean): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  for (const n of steps) {
    writeFileSync(resolve(EVIDENCE_DIR, `step-${String(n).padStart(2, '0')}.png`), 'png')
  }
  if (video) writeFileSync(SLIDES_PATH, 'mp4')
}

export interface Card {
  comments: AdfDoc[]
  attached: number
  assigned: Array<string | null>
  links: string[]
  moved: string[]
}

export interface Refusals {
  /** How many comment posts Jira refuses before it takes one. */
  comments?: number
  /** Attachments Jira refuses, by how many attachments came before them. */
  attachments?: number[]
  /** The statuses the card has a transition to. */
  statuses?: string[]
}

/** Stands up every endpoint a finished turn touches, recording the writes. */
export function card(refuse: Refusals = {}): Card {
  const seen: Card = { comments: [], attached: 0, assigned: [], links: [], moved: [] }
  let refusals = refuse.comments ?? 0
  const statuses = refuse.statuses ?? ['In review']
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),
    http.get(`${ISSUE}/properties/:property`, () =>
      HttpResponse.json({ key: 'factory-assignee', value: { previous: HUMAN } }),
    ),
    http.get(ISSUE, () =>
      HttpResponse.json({ key: 'DF-7', fields: { assignee: { accountId: FACTORY } } }),
    ),
    http.put(`${ISSUE}/assignee`, async ({ request }) => {
      seen.assigned.push(((await request.json()) as { accountId: string | null }).accountId)
      return new HttpResponse(null, { status: 204 })
    }),
    http.post(`${ISSUE}/attachments`, () => {
      const n = seen.attached++
      if (refuse.attachments?.includes(n) === true) return new HttpResponse('no', { status: 500 })
      return HttpResponse.json([{ id: `att-${n}`, filename: 'f', mimeType: 'x', size: 1 }])
    }),
    http.post(`${ISSUE}/comment`, async ({ request }) => {
      if (refusals > 0) {
        refusals -= 1
        return new HttpResponse('INVALID_INPUT', { status: 400 })
      }
      seen.comments.push(((await request.json()) as { body: AdfDoc }).body)
      return HttpResponse.json({ id: '1' }, { status: 201 })
    }),
    http.post(`${ISSUE}/remotelink`, async ({ request }) => {
      seen.links.push(((await request.json()) as { globalId: string }).globalId)
      return HttpResponse.json({ id: 1 }, { status: 201 })
    }),
    http.get(`${ISSUE}/transitions`, () =>
      HttpResponse.json({
        transitions: statuses.map((name, i) => ({ id: String(i + 31), name, to: { name } })),
      }),
    ),
    http.post(`${ISSUE}/transitions`, async ({ request }) => {
      seen.moved.push(((await request.json()) as { transition: { id: string } }).transition.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return seen
}
