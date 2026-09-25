import { spawnSync } from 'node:child_process'
import { REPO_ROOT, optional, required } from './env.ts'

/**
 * Azure Container Apps previews — one app per pull request.
 *
 * Every Azure call shells out to `az`, for the same reason every GitHub call
 * shells out to `gh`: the credential question stays in the workflow YAML
 * (whatever `azure/login` put in the environment) instead of in this code. No
 * step here needs to know how to mint or hold an Azure token.
 *
 * VERIFIED once: PR #16 was built by `az acr build` and served by
 * `az containerapp create` from a live subscription on 2026-09-25, HTTP 200.
 * That was a re-run of the job after fixing the federated credential, so the
 * teardown path and a clean first attempt are still unproven. See
 * docs/factory/SELF-HOSTING.md and the ADR's Consequences section.
 */
export type Runner = (args: string[]) => { status: number; stdout: string; stderr: string }

export const azRunner: Runner = (args) => {
  const result = spawnSync('az', args, { encoding: 'utf8', cwd: REPO_ROOT })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

let runner: Runner = azRunner
/** Test seam — swap in a stub so unit tests never shell out. */
export function setRunner(next: Runner): void {
  runner = next
}
export function getRunner(): Runner {
  return runner
}

export function az(args: string[]): string {
  const result = runner(args)
  if (result.status !== 0) {
    throw new Error(`az ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

export interface AzureConfig {
  resourceGroup: string
  registry: string
  environment: string
  /** Container image repository name, without the registry prefix or tag. */
  repository: string
  /**
   * Which identity the preview app pulls its image with: the literal `system`,
   * or the resource id of a user-assigned managed identity.
   *
   * `system` asks Azure to create the app's own identity and grant it `AcrPull`
   * at create time — which only works if the deploying principal may create
   * role assignments, i.e. holds User Access Administrator on the group. A
   * user-assigned identity is granted `AcrPull` once, up front, by whoever
   * builds the infrastructure; the CI principal then never needs the power to
   * hand out roles at all. `infra/azure/` provisions one and sets this.
   */
  identity: string
}

export function azureConfig(): AzureConfig {
  return {
    resourceGroup: required('AZURE_RESOURCE_GROUP'),
    registry: required('AZURE_ACR_NAME'),
    environment: required('AZURE_CONTAINERAPPS_ENVIRONMENT'),
    repository: required('AZURE_PREVIEW_REPOSITORY'),
    identity: optional('AZURE_PREVIEW_IDENTITY', 'system'),
  }
}

/**
 * Container App names are 2–32 characters, lowercase alphanumeric and hyphens,
 * starting with a letter and ending alphanumeric. `AZURE_PREVIEW_PREFIX` is
 * what keeps two factories sharing one Container Apps environment from
 * colliding on `pr-1`.
 */
export function previewAppName(prNumber: number, prefix = 'df'): string {
  const name = `${prefix}-preview-pr-${prNumber}`
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name)) {
    throw new Error(
      `Derived Container App name "${name}" is not a legal name. ` +
        `AZURE_PREVIEW_PREFIX must be lowercase letters, digits and hyphens.`,
    )
  }
  return name
}

export function previewImage(config: AzureConfig, prNumber: number): string {
  return `${config.registry}.azurecr.io/${config.repository}:pr-${prNumber}`
}

/**
 * Builds the image inside Azure rather than on the runner.
 *
 * `az acr build` uploads the build context and builds it in ACR Tasks, so the
 * job needs no Docker daemon at all. The context is the repository root, not
 * `app/` — see the note at the top of app/Dockerfile.
 */
export function buildImage(config: AzureConfig, prNumber: number): string {
  az([
    'acr',
    'build',
    '--registry',
    config.registry,
    '--image',
    `${config.repository}:pr-${prNumber}`,
    '--file',
    'app/Dockerfile',
    '.',
  ])
  return previewImage(config, prNumber)
}

function appExists(config: AzureConfig, name: string): boolean {
  const result = runner([
    'containerapp',
    'show',
    '--name',
    name,
    '--resource-group',
    config.resourceGroup,
    '--output',
    'none',
  ])
  return result.status === 0
}

/**
 * How long a preview stays awake after its last request.
 *
 * Azure's default is 300 seconds, which is shorter than the gap between the
 * "build finished" notification and somebody actually clicking the link — so
 * the app `preview-up` just warmed has usually gone cold again by the time it
 * matters. An hour covers a review session. Set by infra/azure/ as a repository
 * variable; the default here matches the Terraform default so a clone without
 * the estate behaves the same way.
 */
export function previewCooldownSeconds(): number {
  const raw = optional('AZURE_PREVIEW_COOLDOWN_SECONDS', '3600').trim()
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
    throw new Error(
      `AZURE_PREVIEW_COOLDOWN_SECONDS must be a whole number of seconds between ` +
        `0 and 3600 (Azure's maximum), not "${raw}".`,
    )
  }
  return seconds
}

/**
 * Sets the scale-to-zero cooldown on a preview app.
 *
 * Deliberately `az resource update` and not `az containerapp update`: as of az
 * 2.84.0 the containerapp commands expose no cooldown flag at all, so the only
 * way to reach the property is to patch the ARM resource directly. Verified
 * against a live app — it takes effect in place and creates no new revision,
 * so this does not cost a restart on every turn.
 */
export function setPreviewCooldown(config: AzureConfig, name: string, seconds: number): void {
  az([
    'resource',
    'update',
    '--resource-group',
    config.resourceGroup,
    '--name',
    name,
    '--resource-type',
    'Microsoft.App/containerApps',
    '--set',
    `properties.template.scale.cooldownPeriod=${seconds}`,
    '--output',
    'none',
  ])
}

/**
 * Creates the preview app, or repoints an existing one at the new image.
 *
 * Both paths are needed because this runs on `labeled` AND on `synchronize`:
 * the first push to a build branch creates the app, every later turn updates
 * it. Returns the HTTPS URL.
 *
 * Ingress is external with a target port of 8080, matching the Dockerfile.
 * Azure terminates TLS at the edge and issues the certificate, so nginx never
 * sees a certificate and there is no DNS to configure. The pull uses a managed
 * identity either way — no registry credential is stored anywhere.
 */
export function deployPreview(config: AzureConfig, prNumber: number, prefix?: string): string {
  const name = previewAppName(prNumber, prefix)
  const image = previewImage(config, prNumber)

  // A user-assigned identity has to be attached to the app before it can be
  // named as the one that pulls; `system` is Azure creating that identity
  // itself, so there is nothing to attach.
  const identity =
    config.identity === 'system'
      ? ['--registry-identity', 'system']
      : ['--user-assigned', config.identity, '--registry-identity', config.identity]

  if (appExists(config, name)) {
    az([
      'containerapp',
      'update',
      '--name',
      name,
      '--resource-group',
      config.resourceGroup,
      '--image',
      image,
    ])
  } else {
    az([
      'containerapp',
      'create',
      '--name',
      name,
      '--resource-group',
      config.resourceGroup,
      '--environment',
      config.environment,
      '--image',
      image,
      '--target-port',
      '8080',
      '--ingress',
      'external',
      '--registry-server',
      `${config.registry}.azurecr.io`,
      ...identity,
      // Scale to zero between visits. A preview that nobody is looking at
      // should cost nothing. The trade is a cold start — measured at 22
      // seconds, not the few this comment used to claim — which is why the
      // cooldown below is raised and why human-facing links go through the
      // launcher.
      '--min-replicas',
      '0',
      '--max-replicas',
      '1',
    ])
  }

  // Applied on both paths, every turn, so that changing the repository
  // variable converges without anyone having to recreate an app. A cold start
  // is a nuisance; failing the deployment over one would be worse, so this
  // warns rather than throws.
  try {
    setPreviewCooldown(config, name, previewCooldownSeconds())
  } catch (error) {
    console.warn(
      `::warning::could not set the scale-to-zero cooldown on ${name}, so it keeps ` +
        `Azure's 300s default: ${(error as Error).message}`,
    )
  }

  const fqdn = az([
    'containerapp',
    'show',
    '--name',
    name,
    '--resource-group',
    config.resourceGroup,
    '--query',
    'properties.configuration.ingress.fqdn',
    '--output',
    'tsv',
  ]).trim()

  if (fqdn === '') {
    throw new Error(`Container App ${name} reported no ingress FQDN. Is ingress external?`)
  }
  return `https://${fqdn}`
}

/**
 * Deletes the app and the image tag it ran.
 *
 * Deliberately two independent calls rather than one best-effort block: an app
 * that outlives its PR is a running cost, and an image tag that outlives its
 * PR is a storage cost. The caller decides how loudly each failure lands.
 */
export function deletePreviewApp(config: AzureConfig, prNumber: number, prefix?: string): void {
  az([
    'containerapp',
    'delete',
    '--name',
    previewAppName(prNumber, prefix),
    '--resource-group',
    config.resourceGroup,
    '--yes',
  ])
}

export function deletePreviewImage(config: AzureConfig, prNumber: number): void {
  az([
    'acr',
    'repository',
    'delete',
    '--name',
    config.registry,
    '--image',
    `${config.repository}:pr-${prNumber}`,
    '--yes',
  ])
}
