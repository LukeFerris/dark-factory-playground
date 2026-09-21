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
  created: string
  body: string
}

export async function getComments(cfg: JiraConfig, key: string): Promise<JiraComment[]> {
  const raw = (await call(
    cfg,
    'GET',
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`,
  )) as { comments?: Array<Record<string, unknown>> }

  return (raw.comments ?? []).map((c) => ({
    author: ((c['author'] as Record<string, unknown>)?.['displayName'] as string) ?? 'unknown',
    created: (c['created'] as string) ?? '',
    body: adfToText(c['body']),
  }))
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
