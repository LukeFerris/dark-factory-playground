import { describe, expect, it } from 'vitest'
import {
  bulletList,
  codeBlock,
  doc,
  heading,
  link,
  mention,
  orderedList,
  paragraph,
  strong,
  text,
} from './adf.ts'

/**
 * The shapes Jira's v3 comment API accepts. Each of these was checked against
 * the live instance once; what is pinned here is that they stay that shape,
 * because Jira's answer to a near miss is a 400 with no hint of which node.
 */

describe('inline nodes', () => {
  it('builds plain, bold and linked text', () => {
    expect(text('hi')).toEqual({ type: 'text', text: 'hi' })
    expect(strong('hi')).toEqual({ type: 'text', text: 'hi', marks: [{ type: 'strong' }] })
    expect(link('PR', 'https://example.com/1')).toEqual({
      type: 'text',
      text: 'PR',
      marks: [{ type: 'link', attrs: { href: 'https://example.com/1' } }],
    })
  })

  it('mentions by account id, which is what makes Jira notify the person', () => {
    expect(mention('abc-123')).toEqual({ type: 'mention', attrs: { id: 'abc-123' } })
  })
})

describe('block nodes', () => {
  it('wraps inline nodes in a paragraph, in order', () => {
    expect(paragraph(text('a'), strong('b'))).toEqual({
      type: 'paragraph',
      content: [text('a'), strong('b')],
    })
  })

  it('makes a level-3 heading unless told otherwise', () => {
    expect(heading('Steps')).toEqual({
      type: 'heading',
      attrs: { level: 3 },
      content: [text('Steps')],
    })
    expect(heading('Steps', 2).attrs).toEqual({ level: 2 })
  })

  it('puts code in a code block, with the attrs Jira insists on', () => {
    expect(codeBlock('npm test')).toEqual({
      type: 'codeBlock',
      attrs: {},
      content: [text('npm test')],
    })
  })
})

describe('lists', () => {
  const items = [[text('one')], [text('two'), strong('!')]]

  it('makes one list item, holding one paragraph, per bullet', () => {
    expect(bulletList(items)).toEqual({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('one'))] },
        { type: 'listItem', content: [paragraph(text('two'), strong('!'))] },
      ],
    })
  })

  it('numbers from 1 by default', () => {
    expect(orderedList(items).attrs).toEqual({ order: 1 })
    expect(orderedList(items).content).toEqual(bulletList(items).content)
  })

  // The walkthrough numbers its steps straight through the card, so a second
  // criterion's list carries on from where the first stopped.
  it('can carry the numbering on from an earlier list', () => {
    expect(orderedList(items, 7)).toMatchObject({ type: 'orderedList', attrs: { order: 7 } })
  })
})

describe('the document', () => {
  it('is a version-1 doc holding the blocks it is given', () => {
    expect(doc(paragraph(text('x')), heading('y'))).toEqual({
      type: 'doc',
      version: 1,
      content: [paragraph(text('x')), heading('y')],
    })
  })
})
