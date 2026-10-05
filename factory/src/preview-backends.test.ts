import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ghRunner, renderFactoryBlock, setRunner, type FactoryBlock } from './github.ts'
import { deletePreviewApp, deletePreviewImage, deployPreview } from './azure.ts'
import { updateMeta } from './meta.ts'
import { previewBackend, previewDown, previewUp } from './preview.ts'

/**
 * `preview-up` and `preview-down` against both backends, with every edge of
 * the outside world stubbed: docker through `spawnSync`, Azure through the
 * module, GitHub through the `gh` runner seam, and the warm-up knock through
 * `fetch`. What is left is the part this module owns — which backend does what,
 * in what order, and what it says when one half of a teardown fails.
 */

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('./azure.ts', () => ({
  azureConfig: vi.fn(() => ({ registry: 'acrfactory' })),
  buildImage: vi.fn(),
  deployPreview: vi.fn(() => 'https://df-preview-pr-16.uksouth.azurecontainerapps.io'),
  deletePreviewApp: vi.fn(),
  deletePreviewImage: vi.fn(),
}))
vi.mock('./meta.ts', () => ({ updateMeta: vi.fn() }))

const ok = { status: 0, stdout: '', stderr: '' }
type Call = { args: string[]; input?: string }

/** Records every `gh` call, answering the few whose output preview.ts reads. */
function stubGh(answers: Record<string, unknown>): Call[] {
  const calls: Call[] = []
  setRunner((args, input) => {
    calls.push(input === undefined ? { args } : { args, input })
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k))
    return key === undefined ? ok : { ...ok, stdout: JSON.stringify(answers[key]) }
  })
  return calls
}

const block: FactoryBlock = { key: 'DF-4', stage: 'build', turn: 1 }
const prView = { headRefOid: 'abc123', body: `Prose.\n\n${renderFactoryBlock(block)}` }

beforeEach(() => {
  vi.stubEnv('GITHUB_REPOSITORY', 'Acme/Dark-Factory')
  vi.stubEnv('AZURE_PREVIEW_LAUNCHER', '')
  vi.stubEnv('AZURE_PREVIEW_PREFIX', '')
  vi.stubEnv('GH_TOKEN', 'ghs_token')
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  setRunner(ghRunner)
})

describe('previewBackend', () => {
  it('defaults to the ghcr stub, and ignores case', () => {
    vi.stubEnv('FACTORY_PREVIEW_BACKEND', '')
    expect(previewBackend()).toBe('ghcr')
    vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'AZURE')
    expect(previewBackend()).toBe('azure')
  })

  it('refuses a backend it does not know', () => {
    vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'heroku')
    expect(() => previewBackend()).toThrow('must be "ghcr" or "azure", not "heroku"')
  })
})

describe('previewUp on the ghcr stub', () => {
  beforeEach(() => vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'ghcr'))

  it('builds, logs in, pushes, and records the package page everywhere', async () => {
    const calls = stubGh({
      'pr view': prView,
      'api repos/Acme/Dark-Factory/deployments': { id: 9 },
    })

    const url = await previewUp(16)

    expect(url).toBe('https://github.com/Acme/Dark-Factory/pkgs/container/Dark-Factory')
    const docker = vi.mocked(spawnSync).mock.calls.map((c) => c[1])
    const image = 'ghcr.io/acme/dark-factory:pr-16'
    expect(docker).toEqual([
      ['build', '-f', 'app/Dockerfile', '-t', image, '.'],
      ['login', 'ghcr.io', '-u', 'factory', '--password-stdin'],
      ['push', image],
    ])
    expect(vi.mocked(spawnSync).mock.calls[1]?.[2]).toMatchObject({ input: 'ghs_token' })
    expect(calls.some((c) => c.args.includes(`environment_url=${url}`))).toBe(true)
    const edit = calls.find((c) => c.args[1] === 'edit')
    expect(edit?.input).toContain(`"preview_url": "${url}"`)
    expect(updateMeta).toHaveBeenCalledWith({ preview_url: url })
  })

  it('says so when docker fails, naming the command', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)
    await expect(previewUp(16)).rejects.toThrow(
      /^docker build -f app\/Dockerfile .* failed with 1$/,
    )
  })

  it('stops at a failed registry login rather than pushing', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
    await expect(previewUp(16)).rejects.toThrow('docker login ghcr.io failed')
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('warns, and still finishes, when the PR has no factory block to record on', async () => {
    stubGh({ 'pr view': { headRefOid: 'abc123', body: 'Hand-written.' }, 'api repos': { id: 9 } })
    vi.mocked(updateMeta).mockImplementation(() => {
      throw new Error('no meta.json outside a turn')
    })

    await expect(previewUp(16)).resolves.toContain('/pkgs/container/')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^::warning::PR #16 has no readable factory block/),
    )
  })

  it('touches nothing on a dry run', async () => {
    const calls = stubGh({})
    await expect(previewUp(16, true)).resolves.toContain('/pkgs/container/Dark-Factory')
    expect(spawnSync).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe('previewUp on azure', () => {
  const app = 'https://df-preview-pr-16.uksouth.azurecontainerapps.io'
  beforeEach(() => vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'azure'))

  it('deploys under the prefix, warms the app, and records the raw URL', async () => {
    vi.stubEnv('AZURE_PREVIEW_PREFIX', 'acme')
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    stubGh({ 'pr view': prView, 'api repos': { id: 9 } })

    await expect(previewUp(16)).resolves.toBe(app)

    expect(deployPreview).toHaveBeenCalledWith({ registry: 'acrfactory' }, 16, 'acme')
    expect(fetchImpl).toHaveBeenCalledWith(app, expect.objectContaining({ redirect: 'manual' }))
    expect(spawnSync).not.toHaveBeenCalled()
    expect(updateMeta).toHaveBeenCalledWith({ preview_url: app })
  })

  it('names a placeholder rather than a real app on a dry run', async () => {
    await expect(previewUp(16, true)).resolves.toBe('https://<container-app>.azurecontainerapps.io')
    expect(deployPreview).not.toHaveBeenCalled()
  })
})

describe('previewDown on azure', () => {
  beforeEach(() => vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'azure'))

  it('deactivates the deployment and deletes both the app and the image', () => {
    const calls = stubGh({ 'api repos/Acme/Dark-Factory/deployments?': [{ id: 3 }] })

    previewDown(16)

    expect(calls.some((c) => c.args.includes('state=inactive'))).toBe(true)
    expect(deletePreviewApp).toHaveBeenCalledWith({ registry: 'acrfactory' }, 16, 'df')
    expect(deletePreviewImage).toHaveBeenCalledWith({ registry: 'acrfactory' }, 16)
  })

  /** The app bills by the hour, so a failure on one half never skips the other. */
  it('still deletes the image when the app will not go, and reports both', () => {
    stubGh({ 'api repos': [] })
    vi.mocked(deletePreviewApp).mockImplementation(() => {
      throw new Error('app locked')
    })
    vi.mocked(deletePreviewImage).mockImplementation(() => {
      throw new Error('tag gone')
    })

    previewDown(16)

    expect(deletePreviewImage).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      'preview-down: could not delete the Container App: app locked',
    )
    expect(console.error).toHaveBeenCalledWith(
      'preview-down: could not delete the image tag: tag gone',
    )
  })

  it('changes nothing on a dry run', () => {
    const calls = stubGh({})
    previewDown(16, true)
    expect(calls).toHaveLength(0)
    expect(deletePreviewApp).not.toHaveBeenCalled()
  })
})

describe('previewDown on the ghcr stub', () => {
  const versions = 'users/Acme/packages/container/Dark-Factory/versions'
  beforeEach(() => vi.stubEnv('FACTORY_PREVIEW_BACKEND', 'ghcr'))

  const answers = (tagged: Array<{ id: number; tags: string[] }>) => ({
    'api repos/Acme/Dark-Factory/deployments': [],
    'api repos/Acme/Dark-Factory': { owner: { type: 'User' } },
    [`api ${versions}`]: tagged.map((v) => ({
      id: v.id,
      metadata: { container: { tags: v.tags } },
    })),
  })

  it('deletes only the version tagged for this PR', () => {
    const calls = stubGh(
      answers([
        { id: 1, tags: ['pr-15'] },
        { id: 2, tags: ['pr-16'] },
      ]),
    )

    previewDown(16)

    expect(calls.filter((c) => c.args.includes('DELETE')).map((c) => c.args[3])).toEqual([
      `${versions}/2`,
    ])
    expect(console.log).toHaveBeenCalledWith('preview-down: deleted package version 2 (pr-16)')
  })

  it('says there was nothing to delete when no version carries the tag', () => {
    const calls = stubGh(answers([{ id: 1, tags: ['pr-15'] }]))
    previewDown(16)
    expect(calls.some((c) => c.args.includes('DELETE'))).toBe(false)
    expect(console.log).toHaveBeenCalledWith(
      'preview-down: no package version tagged pr-16; nothing to delete.',
    )
  })

  it('reports, rather than throws, when the package cannot be read', () => {
    setRunner((args) =>
      args[1]?.startsWith('repos/Acme/Dark-Factory/deployments')
        ? { ...ok, stdout: '[]' }
        : { status: 1, stdout: '', stderr: 'forbidden' },
    )
    expect(() => previewDown(16)).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^preview-down: could not clean up the package: .*forbidden/),
    )
  })
})
