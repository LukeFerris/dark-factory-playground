import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProductionImage,
  deployPreview,
  deployProduction,
  previewCooldownSeconds,
  productionAppName,
  productionImage,
  setPreviewCooldown,
} from './azure.ts'
import { config, isFqdnRead, stub, useFakeAz } from './azure.stub.ts'

useFakeAz()

/** Puts AZURE_PREVIEW_COOLDOWN_SECONDS back as it was after each test in the block. */
const restoresTheCooldownVariable = (): void => {
  const previous = process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
  afterEach(() => {
    if (previous === undefined) delete process.env['AZURE_PREVIEW_COOLDOWN_SECONDS']
    else process.env['AZURE_PREVIEW_COOLDOWN_SECONDS'] = previous
  })
}

const cooldownCall = (calls: string[][]): string[] | undefined =>
  calls.find((c) => c[0] === 'resource' && c[1] === 'update')

/**
 * Azure's default is 300 seconds, so an app warmed by `preview-up` had usually
 * gone cold again before anybody clicked the link in the kickoff comment. The
 * property is only reachable through `az resource update`: as of az 2.84.0 the
 * containerapp commands have no cooldown flag at all.
 */
describe('the scale-to-zero cooldown', () => {
  restoresTheCooldownVariable()

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
})

describe('the scale-to-zero cooldown on a deploy', () => {
  restoresTheCooldownVariable()

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
      isFqdnRead(args)
        ? { stdout: 'df-preview-pr-7.kindsky.westeurope.azurecontainerapps.io' }
        : {},
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

describe('production', () => {
  it('is one app, named for the estate rather than for a PR', () => {
    expect(productionAppName()).toBe('df-production')
    expect(productionAppName('shop')).toBe('shop-production')
  })

  it('rejects a prefix that would produce an illegal name', () => {
    expect(() => productionAppName('DF_Factory')).toThrow(/not a legal name/)
  })

  /**
   * Tagged by commit, never `latest`. `az containerapp update --image` only
   * makes a new revision when the reference changes, so pushing new bytes to a
   * fixed tag would leave the old revision serving — a deployment that appears
   * to work indefinitely.
   */
  it('tags the image with the commit it was built from', () => {
    expect(productionImage(config, 'a1b2c3d')).toBe(
      'acmefactory.azurecr.io/dark-factory-playground:main-a1b2c3d',
    )
  })

  it('refuses a tag that is not a commit SHA', () => {
    expect(() => productionImage(config, 'latest')).toThrow(/commit SHA/)
    expect(() => productionImage(config, '')).toThrow(/commit SHA/)
  })
})

describe('deploying production', () => {
  it('builds from the repo root with app/Dockerfile, exactly as a preview does', () => {
    const calls = stub(() => ({}))
    expect(buildProductionImage(config, 'a1b2c3d')).toBe(
      'acmefactory.azurecr.io/dark-factory-playground:main-a1b2c3d',
    )
    expect(calls[0]).toEqual([
      'acr',
      'build',
      '--registry',
      'acmefactory',
      '--image',
      'dark-factory-playground:main-a1b2c3d',
      '--file',
      'app/Dockerfile',
      '.',
    ])
  })

  /** The one difference that matters: production does not sleep. */
  it('creates the app with a floor of one replica and no cooldown', () => {
    const calls = stub((args) =>
      isFqdnRead(args)
        ? { stdout: 'df-production.kindsky.westeurope.azurecontainerapps.io\n' }
        : args[1] === 'show'
          ? { status: 1, stderr: 'ResourceNotFound' }
          : {},
    )

    const url = deployProduction(config, 'a1b2c3d')

    expect(url).toBe('https://df-production.kindsky.westeurope.azurecontainerapps.io')
    const create = calls.find((c) => c[1] === 'create')
    expect(create?.[create.indexOf('--min-replicas') + 1]).toBe('1')
    // Room for a new revision to come up beside the old one during a deploy.
    expect(create?.[create.indexOf('--max-replicas') + 1]).toBe('2')
    // The scale-to-zero cooldown is meaningless when the floor is 1, and
    // setting it would be a needless ARM write on every merge.
    expect(calls.some((c) => c[0] === 'resource' && c[1] === 'update')).toBe(false)
  })

  it('updates an existing app rather than trying to create it again', () => {
    const calls = stub((args) =>
      isFqdnRead(args) ? { stdout: 'df-production.kindsky.westeurope.azurecontainerapps.io' } : {},
    )

    deployProduction(config, 'deadbee')

    expect(calls.some((c) => c[1] === 'create')).toBe(false)
    const update = calls.find((c) => c[1] === 'update')
    expect(update?.[update.indexOf('--image') + 1]).toBe(
      'acmefactory.azurecr.io/dark-factory-playground:main-deadbee',
    )
  })

  it('throws rather than returning a URL with no host', () => {
    stub((args) => (isFqdnRead(args) ? { stdout: '\n' } : {}))
    expect(() => deployProduction(config, 'a1b2c3d')).toThrow(/no ingress FQDN/)
  })
})
