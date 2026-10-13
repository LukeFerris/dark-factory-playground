import { rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_NAMES, configPath, jqlStatus, nameOf, pinnedId, readStatusIds, resetStatusIds, statusOfCard } from './statuses.ts'

/** Ids 10050 to 10059, in the order of STATUS_NAMES. */
const IDS = Object.fromEntries(STATUS_NAMES.map((name, i) => [name, String(10050 + i)]))

function pin(config: unknown): void {
  writeFileSync(configPath(), JSON.stringify(config))
  resetStatusIds()
}

afterEach(() => {
  rmSync(configPath(), { force: true })
  resetStatusIds()
})

describe('with no enki.json', () => {
  it('goes by name', () => {
    expect(readStatusIds()).toBeNull()
    expect(pinnedId('Building')).toBeUndefined()
    expect(jqlStatus('Ready for build')).toBe('"Ready for build"')
    expect(nameOf({ id: '10056', name: 'Building' })).toBe('Building')
  })

  it('goes by name when enki.json pins nothing', () => {
    pin({ jira: {}, allowedPaths: ['src/**'] })
    expect(readStatusIds()).toBeNull()
    expect(jqlStatus('Done')).toBe('"Done"')
  })
})

describe('with the ids pinned', () => {
  it('searches by id', () => {
    pin({ jira: { statuses: IDS } })
    expect(jqlStatus('Ready for build')).toBe('10055')
    expect(pinnedId('ready for build')).toBe('10055')
  })

  it('reads a renamed status by the name the factory knows it by', () => {
    pin({ jira: { statuses: IDS } })
    expect(nameOf({ id: '10056', name: 'Enki is coding' })).toBe('Building')
    expect(statusOfCard({ status: { id: '10059', name: 'Shipped' } })).toBe('Done')
  })

  it('keeps the name of a status that is not one of the ten', () => {
    pin({ jira: { statuses: IDS } })
    expect(nameOf({ id: '99999', name: ' Triage ' })).toBe('Triage')
    expect(jqlStatus('Triage')).toBe('"Triage"')
  })
})

describe('a config it refuses', () => {
  it('refuses some ids but not all ten', () => {
    pin({ jira: { statuses: Object.fromEntries(Object.entries(IDS).filter(([name]) => name !== 'Done')) } })
    expect(() => readStatusIds()).toThrow(/no id for "Done". Pin all ten, or none/)
  })

  it('refuses one id given to two statuses', () => {
    pin({ jira: { statuses: { ...IDS, Done: IDS['Backlog'] } } })
    expect(() => readStatusIds()).toThrow(/"Done" an id already used/)
  })

  it('refuses a name that is not one of the ten, and an id that is not a number', () => {
    pin({ jira: { statuses: { ...IDS, Shipped: '10060' } } })
    expect(() => readStatusIds()).toThrow(/jira\.statuses/)
    pin({ jira: { statuses: { ...IDS, Done: 'Done' } } })
    expect(() => readStatusIds()).toThrow(/all digits/)
  })
})
