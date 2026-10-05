import { required } from './env.ts'

/**
 * The one way the factory talks to Jira's REST API: credentials, the request
 * itself, and what a failure is called. Everything else in `jira.ts` is built
 * on `call`, and `jira.ts` re-exports the parts its callers use.
 */

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

export function authHeader(cfg: JiraConfig): string {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`
}

export async function call(
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
