import { optional } from './env.ts'
import * as jira from './jira.ts'
import { prComments } from './github.ts'
import { writeFileEnsuringDir, writeMeta, TASK_PATH, type Meta } from './meta.ts'
import type { Stage } from './schema.ts'

/**
 * Field id of the "Acceptance criteria" custom field.
 *
 * Custom field ids are per-site, so this is discovered by name rather than
 * hard-coded. bootstrap/jira.sh creates the field; if it is absent we simply
 * omit the section rather than failing the turn.
 */
async function acceptanceCriteria(
  cfg: jira.JiraConfig,
  fields: Record<string, unknown>,
): Promise<string> {
  const all = (await fetchFieldIndex(cfg)).get('acceptance criteria')
  if (all === undefined) return ''
  return jira.adfToText(fields[all]).trim()
}

let fieldIndex: Map<string, string> | null = null
async function fetchFieldIndex(cfg: jira.JiraConfig): Promise<Map<string, string>> {
  if (fieldIndex !== null) return fieldIndex
  const response = await fetch(`${cfg.base}/rest/api/3/field`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`,
      Accept: 'application/json',
    },
  })
  const fields = response.ok ? ((await response.json()) as Array<{ id: string; name: string }>) : []
  fieldIndex = new Map(fields.map((f) => [f.name.toLowerCase(), f.id]))
  return fieldIndex
}

export interface GatherOptions {
  key: string
  stage: Stage
  pr?: number | undefined
}

/**
 * Writes the agent's input: `.agent/in/task.md` (everything it needs to know
 * about the card, as prose) and `.agent/in/meta.json` (the turn's identity).
 *
 * For a build turn it also appends the PR conversation, so the agent can see
 * the human's "go" comments and any review feedback.
 */
export async function gather(options: GatherOptions): Promise<Meta> {
  const cfg = jira.configFromEnv()
  const issue = await jira.getIssue(cfg, options.key)
  const comments = await jira.getComments(cfg, options.key)

  const summary = (issue.fields['summary'] as string) ?? '(no summary)'
  const description = jira.adfToText(issue.fields['description']).trim()
  const criteria = await acceptanceCriteria(cfg, issue.fields)
  const parent = issue.fields['parent'] as { fields?: { summary?: string } } | undefined
  const epic = parent?.fields?.summary ?? ''

  const lines: string[] = [
    `# ${options.key}: ${summary}`,
    '',
    `Stage: **${options.stage}**`,
  ]
  if (epic !== '') lines.push(`Epic: ${epic}`)
  lines.push('', '## Description', '', description === '' ? '_(none given)_' : description)

  lines.push('', '## Acceptance criteria', '', criteria === '' ? '_(none given)_' : criteria)

  if (comments.length > 0) {
    lines.push('', '## Card comments (oldest first)', '')
    for (const c of comments) {
      lines.push(`### ${c.author} — ${c.created}`, '', c.body.trim(), '')
    }
  }

  // Build turns need the PR thread; that is where the human grants each turn
  // and leaves review feedback.
  const turn = await appendPrThread(lines, options)

  writeFileEnsuringDir(TASK_PATH, `${lines.join('\n')}\n`)

  const meta: Meta = {
    key: options.key,
    stage: options.stage,
    turn,
    branch: '',
    pr: options.pr ?? null,
    preview_url: null,
  }
  writeMeta(meta)
  return meta
}

const FACTORY_MARKER = '<!-- factory-turn'

/**
 * Appends the PR conversation since the factory's own last comment, and returns
 * the turn number. Counting the factory's markers is how the pipeline knows
 * which turn this is without storing a counter anywhere.
 */
async function appendPrThread(lines: string[], options: GatherOptions): Promise<number> {
  if (options.stage !== 'build' || options.pr === undefined) return 1

  const botLogin = optional('FACTORY_BOT_LOGIN')
  const comments = prComments(options.pr)
  const factoryComments = comments.filter(
    (c) => c.body.includes(FACTORY_MARKER) || (botLogin !== '' && c.author === botLogin),
  )
  const turn = factoryComments.length + 1

  const last = factoryComments.at(-1)
  const since = last === undefined ? [] : comments.slice(comments.indexOf(last) + 1)

  lines.push('', `## Pull request #${options.pr} — conversation since your last turn`, '')
  if (since.length === 0) {
    lines.push('_(nothing new)_')
  } else {
    for (const c of since) {
      lines.push(`### ${c.author} — ${c.createdAt}`, '', c.body.trim(), '')
    }
  }
  lines.push('', `This is turn ${turn}.`)
  return turn
}
