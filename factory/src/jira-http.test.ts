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

describe('auth failures', () => {
  it('raises JiraAuthError on 401 so the CLI can exit 2', async () => {
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, () => new HttpResponse(null, { status: 401 })),
    )
    await expect(jira.search(cfg, 'project = DF')).rejects.toBeInstanceOf(jira.JiraAuthError)
  })
})

describe('failures other than credentials', () => {
  // Absence is routine for an issue property, so it has a class of its own.
  it('raises JiraNotFoundError on 404, which reading a property treats as "none"', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-9`, () => new HttpResponse('gone', { status: 404 })),
      http.get(
        `${BASE}/rest/api/3/issue/DF-9/properties/factory-triage`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    )
    await expect(jira.getIssue(cfg, 'DF-9')).rejects.toBeInstanceOf(jira.JiraNotFoundError)
    expect(await jira.getIssueProperty(cfg, 'DF-9', 'factory-triage')).toBeNull()
  })

  it('raises a plain error with the method, path and status for anything else', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-9`, () => new HttpResponse('boom', { status: 500 })),
    )
    const failure = jira.getIssue(cfg, 'DF-9')
    await expect(failure).rejects.toThrow('Jira GET /rest/api/3/issue/DF-9 failed: 500 boom')
    await expect(failure).rejects.not.toBeInstanceOf(jira.JiraNotFoundError)
  })

  // The status is the useful part; a body that breaks off must not hide it.
  it('still reports the status when the error body cannot be read', async () => {
    const broken = new ReadableStream({
      start: (controller) => controller.error(new Error('reset')),
    })
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-9`, () => new HttpResponse(broken, { status: 502 })),
    )
    await expect(jira.getIssue(cfg, 'DF-9')).rejects.toThrow(
      'Jira GET /rest/api/3/issue/DF-9 failed: 502 ',
    )
  })

  it('does not swallow a failure reading a property that is not a 404', async () => {
    server.use(
      http.get(
        `${BASE}/rest/api/3/issue/DF-9/properties/factory-triage`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
    await expect(jira.getIssueProperty(cfg, 'DF-9', 'factory-triage')).rejects.toThrow(/500/)
  })
})

describe('requests', () => {
  // Jira answers 415 to a DELETE that does not declare a type, body or not.
  it('declares a JSON content type on a DELETE, which carries no body', async () => {
    let type: string | null = null
    server.use(
      http.delete(`${BASE}/rest/api/3/issue/DF-3/remotelink`, ({ request }) => {
        type = request.headers.get('Content-Type')
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await jira.deleteRemoteLink(cfg, 'DF-3', 'preview')
    expect(type).toBe('application/json')
  })

  it('declares no content type on a GET', async () => {
    let type: string | null = 'unset'
    server.use(
      http.get(`${BASE}/rest/api/3/issue/DF-3`, ({ request }) => {
        type = request.headers.get('Content-Type')
        return HttpResponse.json({ key: 'DF-3', fields: {} })
      }),
    )
    await jira.getIssue(cfg, 'DF-3')
    expect(type).toBeNull()
  })

  it('reads an empty 200 as nothing rather than failing to parse it', async () => {
    server.use(
      http.get(
        `${BASE}/rest/api/3/issue/DF-3/properties/factory-triage`,
        () => new HttpResponse('', { status: 200 }),
      ),
    )
    expect(await jira.getIssueProperty(cfg, 'DF-3', 'factory-triage')).toBeNull()
  })
})

describe('configFromEnv', () => {
  const names = ['JIRA_BASE', 'JIRA_USER', 'JIRA_TOKEN'] as const
  const previous = names.map((name) => process.env[name])
  afterEach(() => {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]
      else process.env[name] = previous[i]
    })
  })

  it('reads the three variables, dropping any trailing slash from the base', () => {
    process.env['JIRA_BASE'] = 'https://example.atlassian.net//'
    process.env['JIRA_USER'] = 'bot@example.com'
    process.env['JIRA_TOKEN'] = 'secret'
    expect(jira.configFromEnv()).toEqual({
      base: 'https://example.atlassian.net',
      user: 'bot@example.com',
      token: 'secret',
    })
  })

  it('names the variable that is missing', () => {
    process.env['JIRA_BASE'] = 'https://example.atlassian.net'
    process.env['JIRA_USER'] = 'bot@example.com'
    delete process.env['JIRA_TOKEN']
    expect(() => jira.configFromEnv()).toThrow(/JIRA_TOKEN/)
  })
})
