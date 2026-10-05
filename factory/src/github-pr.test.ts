import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addLabel,
  commentOnPr,
  createDeployment,
  createDraftPr,
  deactivateDeployments,
  dispatchWorkflow,
  findPrForBranch,
  findPrForCard,
  getRunner,
  ghJson,
  ghRunner,
  markReady,
  prBodyAndBranch,
  prComments,
  repoSlug,
  setPrTitle,
  setRunner,
  updatePrBody,
} from './github.ts'

const REPO = 'acme/dark-factory-playground'

/** One `gh` call as the fake saw it: the arguments and whatever came on stdin. */
interface Call {
  args: string[]
  input?: string
}

/**
 * Installs a fake `gh` that records every call and answers each with whatever
 * `reply` returns for it — stdout, or an Error to fail with.
 */
function fakeGh(reply: (args: string[]) => string | Error = () => ''): Call[] {
  const calls: Call[] = []
  setRunner((args, input) => {
    calls.push(input === undefined ? { args } : { args, input })
    const out = reply(args)
    return out instanceof Error
      ? { status: 1, stdout: '', stderr: out.message }
      : { status: 0, stdout: out, stderr: '' }
  })
  return calls
}

const ENV = ['GITHUB_REPOSITORY', 'GH_OWNER', 'GH_REPO'] as const
const previous = ENV.map((name) => process.env[name])

beforeEach(() => {
  process.env['GITHUB_REPOSITORY'] = REPO
})
afterEach(() => {
  ENV.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]
    else process.env[name] = previous[i]
  })
  setRunner(ghRunner)
})

describe('which repository', () => {
  it('is the one Actions says it is running in', () => {
    expect(repoSlug()).toBe(REPO)
  })

  it('falls back to GH_OWNER and GH_REPO outside Actions', () => {
    process.env['GITHUB_REPOSITORY'] = ''
    process.env['GH_OWNER'] = 'someone'
    process.env['GH_REPO'] = 'elsewhere'
    expect(repoSlug()).toBe('someone/elsewhere')
  })

  it('says what to set when it cannot tell', () => {
    delete process.env['GITHUB_REPOSITORY']
    process.env['GH_OWNER'] = 'someone'
    delete process.env['GH_REPO']
    expect(() => repoSlug()).toThrow(/GITHUB_REPOSITORY, or GH_OWNER and GH_REPO/)
  })
})

describe('the runner seam', () => {
  it('hands back whichever runner was last installed', () => {
    const runner = () => ({ status: 0, stdout: '', stderr: '' })
    setRunner(runner)
    expect(getRunner()).toBe(runner)
  })

  it('reads empty output as null rather than failing to parse it', () => {
    fakeGh(() => '  \n')
    expect(ghJson(['api', 'x'])).toBeNull()
  })
})

describe('finding pull requests', () => {
  const pr = { number: 7, url: 'u', body: 'b', isDraft: true, headRefOid: 'abc' }

  it('finds the open pull request for a branch', () => {
    const calls = fakeGh(() => JSON.stringify([pr]))
    expect(findPrForBranch('card/DF-3-x')).toEqual(pr)
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--head', 'card/DF-3-x', '--repo', REPO]),
    )
  })

  it('finds none for a branch without one', () => {
    fakeGh(() => '[]')
    expect(findPrForBranch('card/DF-3-x')).toBeNull()
  })

  // Without the trailing hyphen DF-3 would also match card/DF-30-….
  it('matches a card by its branch prefix, not a longer key that starts the same', () => {
    fakeGh(() =>
      JSON.stringify([
        { ...pr, number: 30, headRefName: 'card/DF-30-other' },
        { ...pr, number: 3, headRefName: 'card/DF-3-this-one' },
      ]),
    )
    expect(findPrForCard('DF-3')?.number).toBe(3)
    expect(findPrForCard('DF-4')).toBeNull()
  })

  it('reads the body and branch of a pull request by number', () => {
    fakeGh(() => JSON.stringify({ body: 'prose', headRefName: 'card/DF-3-x' }))
    expect(prBodyAndBranch(7)).toEqual({ body: 'prose', headRefName: 'card/DF-3-x' })
  })

  it('reads its comments, filling in whatever GitHub left out', () => {
    fakeGh(() =>
      JSON.stringify({
        comments: [{ author: { login: 'luke' }, createdAt: 't', body: 'hi' }, {}],
      }),
    )
    expect(prComments(7)).toEqual([
      { author: 'luke', createdAt: 't', body: 'hi' },
      { author: 'unknown', createdAt: '', body: '' },
    ])
  })
})

describe('changing pull requests', () => {
  it('opens a draft against main with the body on stdin, and reads it back', () => {
    const pr = { number: 9, url: 'u', body: 'b', isDraft: true, headRefOid: 'abc' }
    const calls = fakeGh((args) => (args[1] === 'list' ? JSON.stringify([pr]) : ''))

    expect(createDraftPr('card/DF-3-x', 'DF-3: a thing', 'the body')).toEqual(pr)
    expect(calls[0]).toEqual({
      args: [
        'pr',
        'create',
        '--repo',
        REPO,
        '--head',
        'card/DF-3-x',
        '--base',
        'main',
        '--title',
        'DF-3: a thing',
        '--body-file',
        '-',
        '--draft',
      ],
      input: 'the body',
    })
  })

  it('says so when the pull request it just opened cannot be found', () => {
    fakeGh((args) => (args[1] === 'list' ? '[]' : ''))
    expect(() => createDraftPr('card/DF-3-x', 't', 'b')).toThrow(
      'Created a PR for card/DF-3-x but could not read it back.',
    )
  })

  it('edits, labels, readies and comments on a pull request by number', () => {
    const calls = fakeGh()
    updatePrBody(7, 'new body')
    setPrTitle(7, 'new title')
    addLabel(7, 'factory')
    markReady(7)
    commentOnPr(7, 'a comment')
    expect(calls).toEqual([
      { args: ['pr', 'edit', '7', '--repo', REPO, '--body-file', '-'], input: 'new body' },
      { args: ['pr', 'edit', '7', '--repo', REPO, '--title', 'new title'] },
      { args: ['pr', 'edit', '7', '--repo', REPO, '--add-label', 'factory'] },
      { args: ['pr', 'ready', '7', '--repo', REPO] },
      { args: ['pr', 'comment', '7', '--repo', REPO, '--body-file', '-'], input: 'a comment' },
    ])
  })
})

describe('starting workflows', () => {
  it('dispatches a workflow with each input as a -f field', () => {
    const calls = fakeGh()
    dispatchWorkflow('design.yml', { key: 'DF-3', turn: '2' })
    expect(calls[0]?.args).toEqual([
      'workflow',
      'run',
      'design.yml',
      '--repo',
      REPO,
      '-f',
      'key=DF-3',
      '-f',
      'turn=2',
    ])
  })
})

describe('deployments', () => {
  it('creates a transient deployment by default, then marks it live at the URL', () => {
    const calls = fakeGh((args) => (args[1]?.endsWith('/deployments') ? '{"id":41}' : ''))
    createDeployment('abc123', 'preview-7', 'https://preview.example')

    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        `repos/${REPO}/deployments`,
        'ref=abc123',
        'environment=preview-7',
        'transient_environment=true',
        'production_environment=false',
      ]),
    )
    expect(calls[1]?.args).toEqual([
      'api',
      `repos/${REPO}/deployments/41/statuses`,
      '-X',
      'POST',
      '-f',
      'state=success',
      '-f',
      'environment_url=https://preview.example',
    ])
  })

  it('says production is permanent and production when asked to', () => {
    const calls = fakeGh((args) => (args[1]?.endsWith('/deployments') ? '{"id":1}' : ''))
    createDeployment('abc', 'production', 'https://x', { transient: false, production: true })
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['transient_environment=false', 'production_environment=true']),
    )
  })

  // Teardown should finish even if one deployment will not go quietly.
  it('marks every deployment of an environment inactive, stepping over failures', () => {
    const calls = fakeGh((args) => {
      if (args[1]?.includes('?environment=')) return '[{"id":1},{"id":2}]'
      return args[1]?.includes('/1/') === true ? new Error('gone') : ''
    })
    deactivateDeployments('preview 7')

    expect(calls[0]?.args).toEqual(['api', `repos/${REPO}/deployments?environment=preview%207`])
    expect(calls.slice(1).map((c) => c.args[1])).toEqual([
      `repos/${REPO}/deployments/1/statuses`,
      `repos/${REPO}/deployments/2/statuses`,
    ])
  })
})
