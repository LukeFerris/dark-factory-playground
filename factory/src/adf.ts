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
 *
 * `start` exists so several lists can share one run of numbers. The walkthrough
 * numbers its steps straight through the card, and a reviewer holding the video
 * beside the comment has to be able to find step 7 in it — which they cannot if
 * every criterion restarts at 1.
 */
export function orderedList(items: AdfNode[][], start = 1): AdfNode {
  return {
    type: 'orderedList',
    attrs: { order: start },
    content: items.map((inline) => ({
      type: 'listItem',
      content: [paragraph(...inline)],
    })),
  }
}

/**
 * An attachment on the card, shown inline in the comment.
 *
 * `collection` is empty and `id` is the attachment id Jira gave back when it
 * took the file: within a comment on the issue the file is attached to, that
 * is enough for the renderer to find it. The width and height are the slide
 * canvas — the media node carries no intrinsic size for a video, and without
 * them the player renders in a box of Jira's choosing.
 *
 * A reader whose Jira cannot play it still has the file in the card's
 * Attachments panel, which is why this is an enrichment of the comment and
 * never the only place the evidence lives.
 */
export function mediaSingle(id: string, width = 1280, height = 980): AdfNode {
  return {
    type: 'mediaSingle',
    attrs: { layout: 'center', width: 100 },
    content: [{ type: 'media', attrs: { type: 'file', id, collection: '', width, height } }],
  }
}

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: 'doc', version: 1, content }
}
