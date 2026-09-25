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
  previewCooldownSeconds,
  previewImage,
  setPreviewCooldown,
  setRunner,
  type AzureConfig,
} from './azure.ts'

const IDENTITY =
  '/subscriptions/0000/resourceGroups/rg-factory/providers/' +
  'Microsoft.ManagedIdentity/userAssignedIdentities/uami-factory-preview'

const config: AzureConfig = {
  resourceGroup: 'rg-factory',
  registry: 'acmefactory',
  environment: 'cae-factory',
  repository: 'dark-factory-playground',
  identity: IDENTITY,
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
    // The identity has to be attached to the app as well as named as the
    // puller, or `az` accepts the create and the first pull fails.
    expect(create?.[create.indexOf('--user-assigned') + 1]).toBe(IDENTITY)
    expect(create?.[create.indexOf('--registry-identity') + 1]).toBe(IDENTITY)
    // Scale to zero: an unvisited preview should cost nothing.
    expect(create?.[create.indexOf('--min-replicas') + 1]).toBe('0')
  })

  /**
   * The fallback for anyone who has not run infra/azure/. It needs the
   * deploying principal to be able to create role assignments, which is
   * exactly what the user-assigned path exists to avoid — but it must keep
   * working, because it is what the SELF-HOSTING instructions described first.
   */
  it('asks Azure for a system-assigned identity when none is configured', () => {
    const calls = stub((args) =>
      isFqdnRead(args)
        ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io\n' }
        : args[1] === 'show'
          ? { status: 1, stderr: 'ResourceNotFound' }
          : {},
    )

    deployPreview({ ...config, identity: 'system' }, 7)

    const create = calls.find((c) => c[1] === 'create')
    expect(create?.[create.indexOf('--registry-identity') + 1]).toBe('system')
    expect(create).not.toContain('--user-assigned')
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

/**
 * Azure's default is 300 seconds, so an app warmed by `preview-up` had usually
 * gone cold again before anybody clicked the link in the kickoff comment. The
 * property is only reachable through `az resource update`: as of az 2.84.0 the
 * containerapp commands have no cooldown flag at all.
 */
describe('the scale-to-zero cooldown', () => {
  const previous = process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']

  afterEach(() => {
    if (previous === undefined) delete process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
    else process.env['AZURE_PREVIEW_COOLDOWN_SECONDS'] = previous
  })

  const cooldownCall = (calls: string[][]): string[] | undefined =>
    calls.find((c) => c[0] === 'resource' && c[1] === 'update')

  it('defaults to an hour, which is a review session rather than a coffee', () => {
    delete process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
    expect(previewCooldownSeconds()).toBe(3600)
  })

  it('refuses a value Azure would reject, rather than sending it', () => {
    process.env['AZURE_PREVIEW_COOLDOWN_SECONDS'] = '7200'
    expect(() => previewCooldownSeconds()).toThrow(/between 0 and 3600/)
    process.env['AZURE_PREVIEW_COOLDOWN_SECONDS'] = 'an hour'
    expect(() => previewCooldownSeconds()).toThrow(/whole number/)
  })

  it('patches the ARM resource directly, since no containerapp flag reaches it', () => {
    delete process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
    const calls = stub(() => ({}))

    setPreviewCooldown(config, 'df-preview-pr-7', 3600)

    expect(calls[0]).toEqual([
      'resource',
      'update',
      '--resource-group',
      'rg-factory',
      '--name',
      'df-preview-pr-7',
      '--resource-type',
      'Microsoft.App/containerApps',
      '--set',
      'properties.template.scale.cooldownPeriod=3600',
      '--output',
      'none',
    ])
  })

  /**
   * Applied on both paths, every turn, so that editing the repository variable
   * converges on apps that already exist instead of only new ones.
   */
  it('is applied when the app is created and when it is updated', () => {
    process.env['AZURE_PREVIEW_COOLDOWN_SECONDS'] = '900'

    const created = stub((args) =>
      isFqdnRead(args)
        ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io' }
        : args[0] === 'containerapp' && args[1] === 'show'
          ? { status: 1, stderr: 'ResourceNotFound' }
          : {},
    )
    deployPreview(config, 7)
    expect(cooldownCall(created)).toContain('properties.template.scale.cooldownPeriod=900')

    const updated = stub((args) =>
      isFqdnRead(args) ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io' } : {},
    )
    deployPreview(config, 7)
    expect(cooldownCall(updated)).toContain('properties.template.scale.cooldownPeriod=900')
  })

  /**
   * A longer cooldown is a nicety. Losing it costs somebody twenty seconds;
   * failing the deployment over it costs them the preview entirely.
   */
  it('warns rather than failing the deployment when it cannot be set', () => {
    delete process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
    stub((args) =>
      isFqdnRead(args)
        ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io' }
        : args[0] === 'resource'
          ? { status: 1, stderr: 'AuthorizationFailed' }
          : {},
    )

    expect(deployPreview(config, 7)).toBe(
      'https://df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io',
    )
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
    'AZURE_PREVIEW_IDENTITY',
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

  it('reads them all from the environment', () => {
    process.env['AZURE_RESOURCE_GROUP'] = 'rg-factory'
    process.env['AZURE_ACR_NAME'] = 'acmefactory'
    process.env['AZURE_CONTAINERAPPS_ENVIRONMENT'] = 'cae-factory'
    process.env['AZURE_PREVIEW_REPOSITORY'] = 'dark-factory-playground'
    process.env['AZURE_PREVIEW_IDENTITY'] = IDENTITY
    expect(azureConfig()).toEqual(config)
  })

  /**
   * Unset is the documented way to ask for a system-assigned identity, so it
   * must not be the same kind of error as a missing resource group.
   */
  it('falls back to a system-assigned identity rather than failing', () => {
    process.env['AZURE_RESOURCE_GROUP'] = 'rg-factory'
    process.env['AZURE_ACR_NAME'] = 'acmefactory'
    process.env['AZURE_CONTAINERAPPS_ENVIRONMENT'] = 'cae-factory'
    process.env['AZURE_PREVIEW_REPOSITORY'] = 'dark-factory-playground'
    delete process.env['AZURE_PREVIEW_IDENTITY']
    expect(azureConfig().identity).toBe('system')
  })
})
