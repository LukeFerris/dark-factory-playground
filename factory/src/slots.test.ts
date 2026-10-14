import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { setRunner } from './github.ts'
import { BASE, cfg, keyOf, server, textOf, useFakes } from './jira.stub.ts'
import {
  WAITING,
  cardOfBranch,
  decideSlot,
  previewSlot,
  readPreviewSlots,
  slotHolders,
  tellWaiting,
  type OpenPr,
} from './slots.ts'

useFakes()

const FACTORY = 'factory-account'
const dir = mkdtempSync(join(tmpdir(), 'slots-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function config(body: unknown): string {
  const file = join(dir, `${Math.random()}.json`)
  writeFileSync(file, JSON.stringify(body))
  return file
}

describe('readPreviewSlots', () => {
  it('sets no limit without enki.json', () => {
    expect(readPreviewSlots(join(dir, 'missing.json'))).toBeNull()
  })

  it('sets no limit when enki.json says nothing about previews', () => {
    expect(readPreviewSlots(config({ paths: { build: ['src/**'] } }))).toBeNull()
  })

  it('reads the cap', () => {
    expect(readPreviewSlots(config({ previews: { slots: 10 } }))).toBe(10)
  })

  // A cap of 0 would stop every card for good, and one of 2.5 means nothing.
  it.each([0, -1, 2.5, '10'])('refuses a cap of %j', (slots) => {
    expect(() => readPreviewSlots(config({ previews: { slots } }))).toThrow(/previews\.slots/)
  })
})

describe('cardOfBranch', () => {
  it('finds the key in a card branch', () => {
    expect(cardOfBranch('card/WKB-183-smoke-test')).toBe('WKB-183')
  })

  it('is null for any other branch', () => {
    expect(cardOfBranch('factory/turn-fixes')).toBeNull()
    expect(cardOfBranch('dependabot/npm_and_yarn/vite-7.1.0')).toBeNull()
  })
})

describe('slotHolders', () => {
  const open: OpenPr[] = [
    { number: 201, headRefName: 'card/WKB-183-smoke-test' },
    { number: 202, headRefName: 'factory/turn-fixes' },
  ]

  it("counts a card and its PR once, and a PR that is not a card's by its number", () => {
    expect(slotHolders(open, ['WKB-183'], [])).toEqual(['#202', 'WKB-183'])
  })

  // Its PR opens at the end of its first turn, and the slot is already spoken for.
  it('counts a card in Designing or Building before its PR exists', () => {
    expect(slotHolders(open, ['WKB-190'], [])).toEqual(['#202', 'WKB-183', 'WKB-190'])
  })

  // Jira's search can lag the move by a moment, so the poller says so itself.
  it('counts a card this run started, whether or not Jira lists it yet', () => {
    expect(slotHolders(open, [], ['WKB-191'])).toEqual(['#202', 'WKB-183', 'WKB-191'])
  })
})

describe('decideSlot', () => {
  const full = ['#202', 'WKB-183', 'WKB-184']

  it('starts anything when there is no cap', () => {
    expect(decideSlot('WKB-190', null, full).start).toBe(true)
  })

  it('starts a card while a slot is free', () => {
    expect(decideSlot('WKB-190', 4, full)).toEqual({
      start: true,
      reason: '3 of 4 preview slots in use',
    })
  })

  it('holds a card back when every slot is held', () => {
    expect(decideSlot('WKB-190', 3, full)).toEqual({
      start: false,
      reason: 'all 3 preview slots are in use (#202, WKB-183, WKB-184)',
    })
  })

  // Stopping it would free nothing.
  it('always starts a card that already holds a slot', () => {
    expect(decideSlot('WKB-183', 3, full).start).toBe(true)
    expect(decideSlot('WKB-183', 1, full).start).toBe(true)
  })
})

/** A board whose cards have the given comments, newest last, recording what is posted. */
function board(comments: Record<string, Array<{ authorId: string; text: string }>>): string[] {
  const posted: string[] = []
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json({ accountId: FACTORY })),
    http.get(`${BASE}/rest/api/3/issue/:key/comment`, ({ params }) => {
      const newestFirst = [...(comments[keyOf(params)] ?? [])].reverse()
      return HttpResponse.json({
        comments: newestFirst.slice(0, 1).map((c, i) => ({
          id: String(i),
          author: { accountId: c.authorId, displayName: c.authorId },
          created: '2026-10-14T10:00:00.000+0000',
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: c.text }] }],
          },
        })),
      })
    }),
    http.post(`${BASE}/rest/api/3/issue/:key/comment`, async ({ params, request }) => {
      const body = (await request.json()) as { body: unknown }
      posted.push(`${keyOf(params)}: ${textOf(body.body)}`)
      return HttpResponse.json({ id: '99' }, { status: 201 })
    }),
  )
  return posted
}

describe('tellWaiting', () => {
  it('says why the card is waiting', async () => {
    const posted = board({ 'WKB-190': [] })
    await tellWaiting(cfg, 'WKB-190', 10)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain(`WKB-190: ${WAITING}.`)
    expect(posted[0]).toContain('all 10 are in use')
  })

  // Every pass asks again, and a comment wakes the poller.
  it('says it once', async () => {
    const posted = board({
      'WKB-190': [{ authorId: FACTORY, text: `${WAITING}. This repository …` }],
    })
    await tellWaiting(cfg, 'WKB-190', 10)
    expect(posted).toEqual([])
  })

  it('says it again after someone else has spoken', async () => {
    const posted = board({
      'WKB-190': [
        { authorId: FACTORY, text: `${WAITING}. This repository …` },
        { authorId: 'luke', text: 'Any news?' },
      ],
    })
    await tellWaiting(cfg, 'WKB-190', 10)
    expect(posted).toHaveLength(1)
  })
})

describe('previewSlot', () => {
  let searched: string[]

  beforeEach(() => {
    searched = []
    setRunner(() => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 201, headRefName: 'card/WKB-183-smoke-test' },
        { number: 202, headRefName: 'factory/turn-fixes' },
      ]),
      stderr: '',
    }))
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        searched.push(((await request.json()) as { jql: string }).jql)
        return HttpResponse.json({ issues: [{ key: 'WKB-184', fields: {} }], isLast: true })
      }),
    )
  })

  it('asks neither GitHub nor Jira when there is no cap', async () => {
    setRunner(() => {
      throw new Error('gh should not be called')
    })
    expect(
      await previewSlot({ cfg, projectKey: 'WKB', key: 'WKB-190', started: [], slots: null }),
    ).toMatchObject({ start: true })
    expect(searched).toEqual([])
  })

  it('counts open PRs and the cards being worked, and starts a card while one is free', async () => {
    const verdict = await previewSlot({
      cfg,
      projectKey: 'WKB',
      key: 'WKB-190',
      started: [],
      slots: 4,
    })
    expect(verdict).toEqual({ start: true, reason: '3 of 4 preview slots in use' })
    expect(searched).toEqual(['project = WKB AND status in ("Designing", "Building")'])
  })

  it('holds a card back, and says so on it, when every slot is held', async () => {
    const posted = board({ 'WKB-190': [] })
    const verdict = await previewSlot({
      cfg,
      projectKey: 'WKB',
      key: 'WKB-190',
      started: ['WKB-189'],
      slots: 4,
    })
    expect(verdict.start).toBe(false)
    expect(verdict.reason).toBe('all 4 preview slots are in use (#202, WKB-183, WKB-184, WKB-189)')
    expect(posted).toHaveLength(1)
  })
})
