import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './env.ts'
import {
  ALLOWED_PATHS,
  ALWAYS_DENIED,
  ResultSchema,
  ResultStatus,
  STATUS_TRANSITIONS,
  Stage,
  toJsonSchema,
} from './schema.ts'

/**
 * The contract has two spellings — the zod the factory parses with and the
 * JSON Schema the agent is handed — and nothing but these tests keeps them
 * saying the same thing.
 */

interface JsonSchema {
  required: string[]
  additionalProperties: boolean
  properties: Record<string, { enum?: string[]; default?: unknown; items?: JsonSchema }>
}

const schema = toJsonSchema() as JsonSchema

describe('the JSON Schema the agent is handed', () => {
  // The same check CI makes with `emit-schema && git diff --exit-code`, here
  // so it fails in the test run rather than only after a push.
  it('is exactly what is committed to .agent/result.schema.json', () => {
    const committed = readFileSync(resolve(REPO_ROOT, '.agent/result.schema.json'), 'utf8')
    expect(`${JSON.stringify(toJsonSchema(), null, 2)}\n`).toBe(committed)
  })

  it('has exactly the fields the zod schema has', () => {
    expect(Object.keys(schema.properties)).toEqual(Object.keys(ResultSchema.shape))
    expect(schema.additionalProperties).toBe(false)
  })

  it('requires only status and summary, and offers every status', () => {
    expect(schema.required).toEqual(['status', 'summary'])
    expect(schema.properties['status']?.enum).toEqual(ResultStatus.options)
  })

  // A default in one spelling and not the other is a field the agent may
  // omit that the factory then chokes on, or the reverse.
  it('defaults every optional field the way zod does', () => {
    const parsed = ResultSchema.parse({ status: 'continue', summary: 'More to do.' })
    for (const [name, value] of Object.entries(parsed)) {
      if (name === 'status' || name === 'summary') continue
      expect(schema.properties[name]?.default, name).toEqual(value)
    }
  })

  it('closes each nested object to its own fields', () => {
    for (const name of ['acceptance_criteria', 'answers', 'questions']) {
      expect(schema.properties[name]?.items?.additionalProperties, name).toBe(false)
    }
    expect(schema.properties['acceptance_criteria']?.items?.required).toEqual([
      'criterion',
      'steps',
    ])
    expect(schema.properties['answers']?.items?.required).toEqual(['question', 'answer'])
    expect(schema.properties['questions']?.items?.required).toEqual(['question'])
  })

  it('returns a fresh object each time, so a caller cannot edit the next one', () => {
    expect(toJsonSchema()).not.toBe(toJsonSchema())
    expect(toJsonSchema()).toEqual(toJsonSchema())
  })
})

describe('where each status sends the card', () => {
  it('has an answer for every status at every stage', () => {
    for (const stage of Stage.options) {
      expect(Object.keys(STATUS_TRANSITIONS[stage]).sort()).toEqual(
        [...ResultStatus.options].sort(),
      )
    }
  })

  // A turn that is not finished has nothing to hand anyone.
  it('leaves the card alone on continue and nowhere else', () => {
    for (const stage of Stage.options) {
      const stays = Object.entries(STATUS_TRANSITIONS[stage]).filter(([, to]) => to === null)
      expect(stays.map(([status]) => status)).toEqual(['continue'])
    }
  })
})

describe('what each stage may write', () => {
  it('has an allow list for every stage', () => {
    expect(Object.keys(ALLOWED_PATHS).sort()).toEqual([...Stage.options].sort())
  })

  it('denies the factory and the workflows outright', () => {
    expect(ALWAYS_DENIED).toEqual(expect.arrayContaining(['.github/**', '.agent/**', 'factory/**']))
  })
})
