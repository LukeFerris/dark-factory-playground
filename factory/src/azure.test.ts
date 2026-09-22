import { afterEach, describe, expect, it } from 'vitest'
import {
  az,
  azRunner,
  azureConfig,
  buildImage,
  deletePreviewApp,
  deletePreviewImage,
  deployPreview,
  previewAppName,
  previewImage,
  setRunner,
  type AzureConfig,
} from './azure.ts'

const config: AzureConfig = {
  resourceGroup: 'rg-factory',
  registry: 'acmefactory',
  environment: 'cae-factory',
  repository: 'dark-factory-playground',
}

/** Records every `az` invocation and answers each one from `reply`. */
function stub(reply: (args: string[]) => { status?: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = []
  setRunner((args) => {
    calls.push(args)
    const answer = reply(args)
    return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  })
  return calls
}

/** `containerapp show --query` is the FQDN read; `--output none` is the existence probe. */
const isFqdnRead = (args: string[]): boolean => args.includes('--query')

afterEach(() => {
  setRunner(azRunner)
})

describe('the Container App name', () => {
  it('is derived from the PR number', () => {
    expect(previewAppName(7)).toBe('df-preview-pr-7')
  })

  /**
   * Azure rejects illegal names at create time, by which point the image has
   * already been built and paid for. Failing here is cheaper and says why.
   */
  it('rejects a prefix that would produce an illegal name', () => {
    expect(() => previewAppName(7, 'DF_Factory')).toThrow(/not a legal name/)
    expect(() => previewAppName(7, '9df')).toThrow(/not a legal name/)
  })

  it('keeps two factories sharing an environment apart', () => {
    expect(previewAppName(7, 'shop')).not.toBe(previewAppName(7, 'admin'))
  })
})

describe('the image reference', () => {
  it('is fully qualified with the registry login server', () => {
    expect(previewImage(config, 12)).toBe('acmefactory.azurecr.io/dark-factory-playground:pr-12')
  })
})

describe('building the image', () => {
  /**
   * The build runs in ACR Tasks, not on the runner, so the job needs no Docker
   * daemon. The context is `.` — the repo root — because app/Dockerfile copies
   * the workspace root's package files.
   */
  it('builds in Azure from the repo root with app/Dockerfile', () => {
    const calls = stub(() => ({}))
    expect(buildImage(config, 12)).toBe('acmefactory.azurecr.io/dark-factory-playground:pr-12')
    expect(calls).toEqual([
      [
        'acr',
        'build',
        '--registry',
        'acmefactory',
        '--image',
        'dark-factory-playground:pr-12',
        '--file',
        'app/Dockerfile',
        '.',
      ],
    ])
  })
})

describe('deploying the preview', () => {
  it('creates the app the first time, with external ingress on 8080', () => {
    const calls = stub((args) =>
      isFqdnRead(args)
        ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io\n' }
        : args[1] === 'show'
          ? { status: 1, stderr: 'ResourceNotFound' }
          : {},
    )

    const url = deployPreview(config, 7)

    expect(url).toBe('https://df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io')
    const create = calls.find((c) => c[1] === 'create')
    expect(create).toBeDefined()
    expect(create).toContain('--ingress')
    expect(create?.[create.indexOf('--ingress') + 1]).toBe('external')
    expect(create?.[create.indexOf('--target-port') + 1]).toBe('8080')
    // Managed identity, so no registry credential is ever stored in Azure.
    expect(create?.[create.indexOf('--registry-identity') + 1]).toBe('system')
    // Scale to zero: an unvisited preview should cost nothing.
    expect(create?.[create.indexOf('--min-replicas') + 1]).toBe('0')
  })

  /**
   * Every build turn pushes, and the workflow runs on `synchronize`, so this is
   * the common path — not the rare one. An update that tried to create would
   * fail on every turn after the first.
   */
  it('updates the image when the app already exists, and does not create', () => {
    const calls = stub((args) =>
      isFqdnRead(args) ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io' } : {},
    )

    deployPreview(config, 7)

    expect(calls.some((c) => c[1] === 'create')).toBe(false)
    const update = calls.find((c) => c[1] === 'update')
    expect(update?.[update.indexOf('--image') + 1]).toBe(
      'acmefactory.azurecr.io/dark-factory-playground:pr-7',
    )
  })

  /**
   * An empty FQDN means ingress is internal or absent. Returning `https://`
   * would put a broken link on the PR and in the agent's PREVIEW_URL.
   */
  it('throws rather than returning a URL with no host', () => {
    stub((args) => (isFqdnRead(args) ? { stdout: '\n' } : {}))
    expect(() => deployPreview(config, 7)).toThrow(/no ingress FQDN/)
  })
})

describe('tearing the preview down', () => {
  it('deletes the app without prompting', () => {
    const calls = stub(() => ({}))
    deletePreviewApp(config, 7)
    expect(calls[0]).toEqual([
      'containerapp',
      'delete',
      '--name',
      'df-preview-pr-7',
      '--resource-group',
      'rg-factory',
      '--yes',
    ])
  })

  it('deletes only the tag for this PR, not the repository', () => {
    const calls = stub(() => ({}))
    deletePreviewImage(config, 7)
    expect(calls[0]).toContain('dark-factory-playground:pr-7')
  })
})

describe('az runner', () => {
  it('throws with stderr when the command fails', () => {
    stub(() => ({ status: 1, stderr: "ERROR: Please run 'az login'" }))
    expect(() => az(['account', 'show'])).toThrow(/az login/)
  })
})

describe('the Azure configuration', () => {
  const names = [
    'AZURE_RESOURCE_GROUP',
    'AZURE_ACR_NAME',
    'AZURE_CONTAINERAPPS_ENVIRONMENT',
    'AZURE_PREVIEW_REPOSITORY',
  ] as const
  const previous = names.map((n) => process.env[n])

  afterEach(() => {
    names.forEach((n, i) => {
      const value = previous[i]
      if (value === undefined) delete process.env[n]
      else process.env[n] = value
    })
  })

  it('names the missing variable instead of failing at the az call', () => {
    names.forEach((n) => delete process.env[n])
    expect(() => azureConfig()).toThrow(/AZURE_RESOURCE_GROUP/)
  })

  it('reads all four from the environment', () => {
    process.env['AZURE_RESOURCE_GROUP'] = 'rg-factory'
    process.env['AZURE_ACR_NAME'] = 'acmefactory'
    process.env['AZURE_CONTAINERAPPS_ENVIRONMENT'] = 'cae-factory'
    process.env['AZURE_PREVIEW_REPOSITORY'] = 'dark-factory-playground'
    expect(azureConfig()).toEqual(config)
  })
})
