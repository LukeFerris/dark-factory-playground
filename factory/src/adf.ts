/**
 * Atlassian Document Format builders.
 *
 * Jira's v3 comment API takes ADF, not text. Every comment the factory posts is
 * built through these helpers — the plan's rule is "never string-concatenate
 * JSON", and a typed builder is how that rule is kept.
 */

export interface AdfNode {
  type: string
  [key: string]: unknown
}

export interface AdfDoc {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

export function text(value: string): AdfNode {
  return { type: 'text', text: value }
}

export function strong(value: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'strong' }] }
}

export function link(value: string, href: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] }
}

export function paragraph(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content }
}

export function heading(value: string, level = 3): AdfNode {
  return { type: 'heading', attrs: { level }, content: [text(value)] }
}

export function codeBlock(value: string): AdfNode {
  return { type: 'codeBlock', attrs: {}, content: [text(value)] }
}

/** A bullet list. Each item is a list of inline nodes. */
export function bulletList(items: AdfNode[][]): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((inline) => ({
      type: 'listItem',
      content: [paragraph(...inline)],
    })),
  }
}

/**
 * A numbered list. Each item is a list of inline nodes.
 *
 * Used for the steps that prove a criterion: they are taken in order, so a
 * reviewer following them needs to know which comes first. The criteria
 * themselves are bulleted — they are true together, not in sequence.
 */
export function orderedList(items: AdfNode[][]): AdfNode {
  return {
    type: 'orderedList',
    attrs: { order: 1 },
    content: items.map((inline) => ({
      type: 'listItem',
      content: [paragraph(...inline)],
    })),
  }
}

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: 'doc', version: 1, content }
}
