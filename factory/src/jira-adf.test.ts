import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import * as jira from './jira.ts'

const BASE = 'https://example.atlassian.net'
const cfg: jira.JiraConfig = { base: BASE, user: 'me@example.com', token: 'token' }

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('adfToText', () => {
  it('flattens paragraphs and bullet lists to readable text', () => {
    const body = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
      ],
    }
    expect(jira.adfToText(body)).toContain('First line.')
    expect(jira.adfToText(body)).toContain('- one')
    expect(jira.adfToText(body)).toContain('- two')
  })

  it('returns an empty string for a missing body rather than throwing', () => {
    expect(jira.adfToText(undefined)).toBe('')
    expect(jira.adfToText(null)).toBe('')
  })
})

describe('mentions', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: '712020:factory', text: '@Enki [bot]' } },
          { type: 'text', text: ' please look' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: '557058:human' } }] },
    ],
  }

  it('reads every mentioned account id, from the document rather than the text', () => {
    expect(jira.mentionedIds(doc)).toEqual(['712020:factory', '557058:human'])
  })

  it('finds none in a comment without mentions', () => {
    expect(jira.mentionedIds({ type: 'doc', content: [{ type: 'text', text: '@Enki' }] })).toEqual(
      [],
    )
    expect(jira.mentionedIds(undefined)).toEqual([])
  })

  // The classifier reads the text, and "please look" without who it was said
  // to reads like a note between people.
  it('keeps the mention in the text', () => {
    expect(jira.adfToText(doc)).toBe('@Enki [bot] please look\n@someone\n')
  })

  // "@Enki stop" is a command because of the word after the mention, and the
  // mention's display name is whatever the account is called this week.
  it('can leave the mentions out, for reading what was said rather than to whom', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3/comment`, () =>
        HttpResponse.json({
          comments: [
            {
              id: '1',
              author: { displayName: 'Luke', accountId: '557058:human' },
              created: 'x',
              body: doc,
            },
          ],
        }),
      ),
    )
    const [only] = await jira.recentComments(cfg, 'DF-3', 1)
    expect(only?.bodyWithoutMentions).toBe(' please look\n\n')
    expect(only?.body).toBe('@Enki [bot] please look\n@someone\n')
  })
})

describe('adfToText layout', () => {
  it('ends a heading with a newline and turns a hard break into one', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    }
    expect(jira.adfToText(doc)).toBe('Title\none\ntwo\n')
  })

  // Node types are whatever Jira sends. One that happens to share a name with
  // something on Object's prototype must still read as an unknown container.
  it('reads an unknown node type as just its children', () => {
    const doc = { type: 'constructor', content: [{ type: 'text', text: 'kept' }] }
    expect(jira.adfToText(doc)).toBe('kept')
  })
})
