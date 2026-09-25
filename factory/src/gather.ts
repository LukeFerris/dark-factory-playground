import { optional } from './env.ts'
import * as jira from './jira.ts'
import { git } from './git.ts'
import { parseFactoryBlock, prBodyAndBranch, prComments } from './github.ts'
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

/**
 * Where the PR's preview is, if it has one and anybody recorded it.
 *
 * This used to be hard-coded to null, which meant PREVIEW_URL was empty in
 * every build turn there has ever been: the agent was told to go and look at
 * the running site and given nowhere to look. `preview-up` writes the URL into
 * the PR's factory block precisely so a later run — a different workflow on a
 * different runner — can read it back here.
 *
 * Tolerant of failure. A turn with no preview URL is worse than one with it,
 * but it still runs; a turn that cannot start because `gh` hiccuped does not.
 */
function previewUrlOf(pr: number | undefined): string | null {
  if (pr === undefined) return null
  try {
    return parseFactoryBlock(prBodyAndBranch(pr).body)?.preview_url ?? null
  } catch (error) {
    console.warn(`::warning::could not read the preview URL off PR #${pr}: ${(error as Error).message}`)
    return null
  }
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

  // Which of these comments are ours. A design turn can be re-entered after a
  // human answers, and the agent has no memory of the turn that asked — so the
  // difference between "a question I raised" and "the reply to it" has to be on
  // the page. Tolerant of failure: an unidentifiable factory still runs the
  // turn, it just labels every comment neutrally.
  const factoryId = await jira.myAccountId(cfg).catch(() => '')
  const isOurs = (c: jira.JiraComment): boolean => factoryId !== '' && c.authorId === factoryId

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
      const who = isOurs(c) ? `${c.author} — you, on an earlier turn` : c.author
      lines.push(`### ${who} — ${c.created}`, '', c.body.trim(), '')
    }
  }

  // Build turns need the PR thread; that is where the human grants each turn
  // and leaves review feedback. A design turn has no thread to read — its
  // conversation is the card itself, which is already above.
  const turn =
    options.stage === 'design'
      ? appendDesignRound(lines, comments.filter(isOurs).length)
      : await appendPrThread(lines, options)

  writeFileEnsuringDir(TASK_PATH, `${lines.join('\n')}\n`)

  const meta: Meta = {
    key: options.key,
    stage: options.stage,
    turn,
    branch: '',
    // The checked-out HEAD, which is the turn's base for the flows that come
    // in on the card's branch already — build-turn.yml checks the PR branch
    // out itself and never calls prepare-branch. The flows that do call it
    // overwrite this with the post-checkout HEAD, which is the correct one for
    // them. Tolerant of a missing git because a turn is replayable locally.
    base_sha: git(['rev-parse', 'HEAD'], true).trim(),
    pr: options.pr ?? null,
    preview_url: previewUrlOf(options.pr),
  }
  writeMeta(meta)
  return meta
}

const FACTORY_MARKER = '<!-- factory-turn'

/**
 * Tells a design turn which round it is, and returns the turn number.
 *
 * Counted from the factory's own comments on the card, the same trick the build
 * stage plays with its PR markers: no counter is stored anywhere, so a card
 * cannot disagree with itself about how many turns it has had.
 *
 * Turn 2 and beyond only happen because a human answered, so the agent is told
 * plainly what changed since it last looked. Without this it re-reads its own
 * questions with no signal that they now have replies.
 */
function appendDesignRound(lines: string[], priorTurns: number): number {
  const turn = priorTurns + 1
  lines.push('', `This is design turn ${turn}.`)
  if (turn > 1) {
    lines.push(
      '',
      'You asked questions on an earlier turn and they have been answered in the',
      'card comments above. Read the answers, fold them into the design document',
      'that is already on this branch, and finish the design if nothing else is',
      'outstanding. Ask again only about what is still genuinely undecided.',
    )
  }
  return turn
}

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
