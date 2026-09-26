import { required } from './env.ts'
import type { AdfDoc } from './adf.ts'

/** Thrown for a 401/403 from Jira, so the CLI can exit 2 rather than 1. */
export class JiraAuthError extends Error {}
/**
 * Thrown for a 404.
 *
 * Its own class because absence is routine for some of what the factory asks
 * for — an issue property no card has ever had, a link it is removing for the
 * second time — and "it is not there" should be distinguishable from "Jira
 * broke" without reading the message.
 */
export class JiraNotFoundError extends Error {}
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
  // DELETE carries no body and still has to declare a content type: Jira answers
  // 415 Unsupported Media Type without one. Found by calling it, not by reading
  // the docs, which say nothing about it — so this is load-bearing and pinned by
  // a test rather than left to look like a redundant header.
  const declaresType = body !== undefined || method === 'DELETE'

  const response = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      Authorization: authHeader(cfg),
      Accept: 'application/json',
      ...(declaresType ? { 'Content-Type': 'application/json' } : {}),
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
    const message = `Jira ${method} ${path} failed: ${response.status} ${detail.slice(0, 500)}`
    throw response.status === 404 ? new JiraNotFoundError(message) : new Error(message)
  }
  if (response.status === 204) return null
  const raw = await response.text()
  return raw === '' ? null : JSON.parse(raw)
}

export interface JiraIssue {
  key: string
  fields: Record<string, unknown>
  /** Populated only when `search` or a GET asked for named issue properties. */
  properties?: Record<string, unknown>
}

/**
 * Runs a JQL search, following pagination.
 *
 * Uses POST /rest/api/3/search/jql — the older GET /search was removed from
 * Jira Cloud. The new endpoint pages with an opaque `nextPageToken` rather than
 * startAt/total.
 *
 * `properties` rides along on the same request. That matters for triage, which
 * needs each card's status and its high-water mark together: asking for both
 * here is one call for the whole board instead of one per card.
 */
export async function search(
  cfg: JiraConfig,
  jql: string,
  fields: string[] = ['key'],
  properties: string[] = [],
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = []
  let nextPageToken: string | undefined

  do {
    const page = (await call(cfg, 'POST', '/rest/api/3/search/jql', {
      jql,
      fields,
      maxResults: 100,
      ...(properties.length === 0 ? {} : { properties }),
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
  /**
   * The comment's own id.
   *
   * Triage remembers the last comment it looked at by this id, which is the
   * only thing that stops a card whose comment was judged "no action" being
   * re-judged on every pass for the rest of its life — a timestamp would work
   * too, but an id cannot be ambiguous about two comments in the same second.
   */
  id: string
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
    id: (c['id'] as string) ?? '',
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
 * Has someone other than the factory spoken last on this card?
 *
 * Every turn ends with `report()` posting a comment, so a card the factory has
 * put down carries the factory's own words as its last. Anything newer came
 * from a person, and is the only thing on the card worth reacting to.
 *
 * This is the cheap first filter in front of triage: it costs one request and
 * rules out every card nobody has touched, so the expensive part — reading the
 * thread and asking a model what the comment wants — only ever runs on cards
 * where there is something new to read. A card with no comments at all is not
 * answered: nobody has said anything.
 *
 * Takes the newest comment rather than the thread, so there is no end of an
 * array to pick the wrong one of, and no page size to get wrong.
 */
export function isAnswered(newest: JiraComment | null, factoryAccountId: string): boolean {
  if (newest === null) return false
  return newest.authorId !== factoryAccountId
}

/**
 * Writes a named issue property — arbitrary JSON hung off a card.
 *
 * Invisible on the card and in its history, which is exactly what is wanted
 * for the factory's own bookkeeping: a "triage has seen this" marker is not
 * something a human reading the ticket should have to scroll past. Needs only
 * the *Edit Issues* permission the bot already has.
 */
export async function setIssueProperty(
  cfg: JiraConfig,
  key: string,
  property: string,
  value: unknown,
): Promise<void> {
  await call(
    cfg,
    'PUT',
    `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(property)}`,
    value,
  )
}

/**
 * Reads a named issue property back, or null if the card has never had one.
 *
 * Triage gets its marks for free on the search that finds the cards, so this is
 * for the one-card case — `announce` remembering who held a card before it took
 * it. A 404 here is the normal state of most cards and not an error.
 */
export async function getIssueProperty(
  cfg: JiraConfig,
  key: string,
  property: string,
): Promise<unknown> {
  try {
    const raw = (await call(
      cfg,
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(property)}`,
    )) as { value?: unknown } | null
    return raw?.value ?? null
  } catch (error) {
    if (error instanceof JiraNotFoundError) return null
    throw error
  }
}

export async function addComment(cfg: JiraConfig, key: string, body: AdfDoc): Promise<void> {
  await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body })
}

/**
 * Puts a link in the card's **Web links** panel, replacing the one that was
 * there before.
 *
 * Keyed by `globalId`: Jira treats issue + globalId as the identity of a remote
 * link, so posting the same id twice updates the row rather than adding a
 * second. That is the whole reason this exists. A URL that changes — the
 * preview, which is rebuilt every build turn — accumulates one copy per turn in
 * the comment stream, and the reader has to work out which is current. As a
 * link there is exactly one row and it is always the live one.
 *
 * Deliberately no icon. An icon is a URL on somebody else's CDN rendered inside
 * the card, and a generic one costs nothing.
 */
export async function setRemoteLink(
  cfg: JiraConfig,
  key: string,
  link: { globalId: string; title: string; url: string },
): Promise<void> {
  await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
    globalId: link.globalId,
    object: { url: link.url, title: link.title },
  })
}

/** Removes the link with this `globalId`, if the card has one. */
export async function deleteRemoteLink(
  cfg: JiraConfig,
  key: string,
  globalId: string,
): Promise<void> {
  await call(
    cfg,
    'DELETE',
    `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink?globalId=${encodeURIComponent(globalId)}`,
  )
}

/** The account id currently assigned to a card, or '' if nobody is. */
export async function assigneeOf(cfg: JiraConfig, key: string): Promise<string> {
  const issue = await getIssue(cfg, key)
  const assignee = issue.fields['assignee'] as { accountId?: string } | null | undefined
  return assignee?.accountId ?? ''
}

/**
 * Assigns a card, or unassigns it when `accountId` is ''.
 *
 * Assignment is not a comment. It shows as an avatar on the board and a line in
 * the card's history, and it notifies nobody — which makes it the right shape
 * for "this is being worked on right now" and the wrong shape for anything a
 * person needs to read.
 */
export async function assign(cfg: JiraConfig, key: string, accountId: string): Promise<void> {
  await call(cfg, 'PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
    accountId: accountId === '' ? null : accountId,
  })
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
