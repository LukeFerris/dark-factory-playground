import { required } from './env.ts'
import type { AdfDoc } from './adf.ts'

/** Thrown for a 401/403 from Jira, so the CLI can exit 2 rather than 1. */
export class JiraAuthError extends Error {}
/** Thrown when a named transition is not available from the card's current status. */
export class JiraTransitionError extends Error {}

export interface JiraConfig {
  base: string
  user: string
  token: string
}

export function configFromEnv(): JiraConfig {
  return {
    base: required('JIRA_BASE').replace(/\/+$/, ''),
    user: required('JIRA_USER'),
    token: required('JIRA_TOKEN'),
  }
}

function authHeader(cfg: JiraConfig): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`
}

async function call(
  cfg: JiraConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      Authorization: authHeader(cfg),
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  if (response.status === 401 || response.status === 403) {
    throw new JiraAuthError(
      `Jira rejected the credentials (${response.status}) on ${method} ${path}. ` +
        `Check JIRA_USER and JIRA_TOKEN.`,
    )
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Jira ${method} ${path} failed: ${response.status} ${detail.slice(0, 500)}`)
  }
  if (response.status === 204) return null
  const raw = await response.text()
  return raw === '' ? null : JSON.parse(raw)
}

export interface JiraIssue {
  key: string
  fields: Record<string, unknown>
}

/**
 * Runs a JQL search, following pagination.
 *
 * Uses POST /rest/api/3/search/jql — the older GET /search was removed from
 * Jira Cloud. The new endpoint pages with an opaque `nextPageToken` rather than
 * startAt/total.
 */
export async function search(
  cfg: JiraConfig,
  jql: string,
  fields: string[] = ['key'],
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = []
  let nextPageToken: string | undefined

  do {
    const page = (await call(cfg, 'POST', '/rest/api/3/search/jql', {
      jql,
      fields,
      maxResults: 100,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    })) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }

    issues.push(...(page.issues ?? []))
    nextPageToken = page.isLast === true ? undefined : page.nextPageToken
  } while (nextPageToken !== undefined)

  return issues
}

export async function getIssue(cfg: JiraConfig, key: string): Promise<JiraIssue> {
  return (await call(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}`)) as JiraIssue
}

export interface JiraComment {
  author: string
  /**
   * The author's Jira account id.
   *
   * Display names are not identity — two accounts can share one, and for most
   * of this repository's life the factory posted under the same name as the
   * human it works for. Everything that asks "did the factory write this?"
   * compares account ids.
   */
  authorId: string
  created: string
  body: string
}

function toComment(c: Record<string, unknown>): JiraComment {
  const author = c['author'] as Record<string, unknown> | undefined
  return {
    author: (author?.['displayName'] as string) ?? 'unknown',
    authorId: (author?.['accountId'] as string) ?? '',
    created: (c['created'] as string) ?? '',
    body: adfToText(c['body']),
  }
}

/**
 * The card's conversation, oldest first, for putting in front of the agent.
 *
 * Capped at 100 — a design card with more comments than that has a problem no
 * extra context will solve. Nothing decides anything from the end of this list;
 * `latestComment` exists so that the truncation cannot be mistaken for the
 * newest comment.
 */
export async function getComments(cfg: JiraConfig, key: string): Promise<JiraComment[]> {
  const raw = (await call(
    cfg,
    'GET',
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`,
  )) as { comments?: Array<Record<string, unknown>> }

  return (raw.comments ?? []).map(toComment)
}

/**
 * The newest comment on a card, or null if it has none.
 *
 * Asked for in descending order and one at a time: this is what the poller runs
 * against every blocked card on every pass, and it is the one question where
 * reading the wrong end of a truncated page would be silently wrong rather than
 * merely incomplete.
 */
export async function latestComment(cfg: JiraConfig, key: string): Promise<JiraComment | null> {
  const raw = (await call(
    cfg,
    'GET',
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=1`,
  )) as { comments?: Array<Record<string, unknown>> }

  const newest = (raw.comments ?? [])[0]
  return newest === undefined ? null : toComment(newest)
}

/**
 * The account id of whoever these credentials belong to.
 *
 * In a workflow that is the factory's bot account, which is what makes "the
 * newest comment is not ours" answerable. Deliberately not cached across
 * processes: a turn is short, and a stale id here would silently mistake the
 * factory's own questions for a human's answers.
 */
export async function myAccountId(cfg: JiraConfig): Promise<string> {
  const me = (await call(cfg, 'GET', '/rest/api/3/myself')) as { accountId?: string }
  const id = me.accountId ?? ''
  if (id === '') throw new Error('Jira /myself returned no accountId; cannot identify the factory.')
  return id
}

/**
 * Has a human replied since the factory last spoke on this card?
 *
 * The factory always comments *before* it transitions — see `report()` — so a
 * card parked in a blocked status carries the agent's question as its last
 * word. Anything newer than that came from someone else, and is the answer.
 *
 * Takes the newest comment rather than the thread, so there is no end of an
 * array to pick the wrong one of, and no page size to get wrong. A card with no
 * comments at all is not answered: there was no question.
 */
export function isAnswered(newest: JiraComment | null, factoryAccountId: string): boolean {
  if (newest === null) return false
  return newest.authorId !== factoryAccountId
}

/**
 * Keys of cards sitting in `status` whose questions have been answered.
 *
 * One comment fetch per card, which is why this is scoped to a single status
 * rather than run across the board: the blocked column is short, and the poller
 * runs this every thirty seconds. An empty column costs one search and nothing
 * else — not even the /myself call.
 */
export async function findAnswered(
  cfg: JiraConfig,
  projectKey: string,
  status: string,
): Promise<string[]> {
  const waiting = await search(
    cfg,
    `project = ${projectKey} AND status = "${status}" ORDER BY created ASC`,
  )
  if (waiting.length === 0) return []

  const me = await myAccountId(cfg)
  const answered: string[] = []
  for (const issue of waiting) {
    if (isAnswered(await latestComment(cfg, issue.key), me)) answered.push(issue.key)
  }
  return answered
}

export async function addComment(cfg: JiraConfig, key: string, body: AdfDoc): Promise<void> {
  await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body })
}

export interface Transition {
  id: string
  name: string
  to: { name: string }
}

export async function getTransitions(cfg: JiraConfig, key: string): Promise<Transition[]> {
  const raw = (await call(
    cfg,
    'GET',
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
  )) as { transitions?: Transition[] }
  return raw.transitions ?? []
}

/**
 * Moves a card to a status BY TARGET STATUS NAME, not by transition name.
 *
 * Transition names drift ("Start progress" vs "In Progress"); the destination
 * status name is what the state machine in docs/factory/STATE-MACHINE.md is
 * written against, so that is what we match on.
 */
export async function transitionTo(
  cfg: JiraConfig,
  key: string,
  statusName: string,
): Promise<void> {
  const transitions = await getTransitions(cfg, key)
  const wanted = statusName.toLowerCase()
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === wanted)

  if (match === undefined) {
    const available = transitions.map((t) => t.to?.name ?? t.name).join(', ')
    throw new JiraTransitionError(
      `${key} has no transition to "${statusName}". Available: ${available || '(none)'}`,
    )
  }

  await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    transition: { id: match.id },
  })
}

/** Flattens an ADF document to plain text, for putting card content in a prompt. */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node

  const n = node as Record<string, unknown>
  if (n['type'] === 'text' && typeof n['text'] === 'string') return n['text']

  const children = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  const joiner =
    n['type'] === 'paragraph' || n['type'] === 'heading' || n['type'] === 'listItem' ? '' : ''
  const inner = children.map(adfToText).join(joiner)

  if (n['type'] === 'paragraph' || n['type'] === 'heading') return `${inner}\n`
  if (n['type'] === 'listItem') return `- ${inner.trim()}\n`
  if (n['type'] === 'hardBreak') return '\n'
  return inner
}
