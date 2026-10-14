import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { setupServer } from 'msw/node'
import type { PathParams } from 'msw'
import type * as jira from './jira.ts'
import { ghRunner, setRunner } from './github.ts'

/**
 * The fake Jira site the tests that talk to Jira run against: its address, the
 * credentials for it, and the server that answers it.
 *
 * Not a test file itself, so the tests that use it are what cover it. Each test
 * file that imports it gets its own copy, and with it its own server. The
 * routes are each test's own; this only starts, resets and stops the server.
 */

export const BASE = 'https://example.atlassian.net'
export const cfg: jira.JiraConfig = { base: BASE, user: 'bot@example.com', token: 'token' }

/** Exported so a test can answer the requests it cares about. */
export const server = setupServer()

/** Starts the server for the file that calls it, and puts everything back after. */
export function useFakes(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' })
    // `dispatchWorkflow` resolves the repository before it shells out, so
    // without this every dispatch fails for the wrong reason.
    vi.stubEnv('GITHUB_REPOSITORY', 'acme/dark-factory-playground')
  })
  afterEach(() => {
    server.resetHandlers()
    setRunner(ghRunner)
  })
  afterAll(() => {
    server.close()
    vi.unstubAllEnvs()
  })
}

/** The issue key in a route such as `/issue/:key/comment`. */
export const keyOf = (params: PathParams): string => params['key'] as string

/** The text of an ADF node and everything under it, the pieces joined by `joiner`. */
export function textOf(node: unknown, joiner = ' '): string {
  if (node === null || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  const own = typeof n['text'] === 'string' ? (n['text'] as string) : ''
  const kids = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return own + kids.map((kid) => textOf(kid, joiner)).join(joiner)
}

/** The card a route is about. A card the board does not have is a broken test. */
export function cardOf<T>(cards: Record<string, T>, params: PathParams): T {
  const card = cards[keyOf(params)]
  if (card === undefined) throw new Error(`${keyOf(params)} is not on the fake board`)
  return card
}

/** What a comment needs to be sent the way Jira sends one. */
export type CommentFields = Pick<
  jira.JiraComment,
  'id' | 'author' | 'authorId' | 'created' | 'bodyWithoutMentions' | 'mentions'
>

/** A comment as Jira sends it, with its mentions at the start of the document. */
export function asJiraComment(c: CommentFields): Record<string, unknown> {
  const mentions = c.mentions.map((id) => ({ type: 'mention', attrs: { id, text: '@Enki' } }))
  return {
    id: c.id,
    author: { displayName: c.author, accountId: c.authorId },
    created: c.created,
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [...mentions, { type: 'text', text: c.bodyWithoutMentions }],
        },
      ],
    },
  }
}
