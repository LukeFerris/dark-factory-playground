import { afterEach } from 'vitest'
import { azRunner, setRunner, type AzureConfig } from './azure.ts'

/**
 * The fake `az` the Azure tests run against: a configuration, and a runner that
 * records every invocation and answers it.
 *
 * Not a test file itself, so the tests that use it are what cover it.
 */

export const IDENTITY =
  '/subscriptions/0000/resourceGroups/rg-factory/providers/' +
  'Microsoft.ManagedIdentity/userAssignedIdentities/uami-factory-preview'

export const config: AzureConfig = {
  resourceGroup: 'rg-factory',
  registry: 'acmefactory',
  environment: 'cae-factory',
  repository: 'dark-factory-playground',
  identity: IDENTITY,
}

/** Records every `az` invocation and answers each one from `reply`. */
export function stub(
  reply: (args: string[]) => { status?: number; stdout?: string; stderr?: string },
): string[][] {
  const calls: string[][] = []
  setRunner((args) => {
    calls.push(args)
    const answer = reply(args)
    return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  })
  return calls
}

/** `containerapp show --query` is the FQDN read; `--output none` is the existence probe. */
export const isFqdnRead = (args: string[]): boolean => args.includes('--query')

/** Puts the real `az` back after each test in the file that calls it. */
export function useFakeAz(): void {
  afterEach(() => {
    setRunner(azRunner)
  })
}
