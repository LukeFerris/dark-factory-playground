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

/*
 * There is deliberately no `media`/`mediaSingle` helper here.
 *
 * Embedding an attachment inline looks like the obvious way to put the
 * walkthrough in front of the reviewer, and the REST v3 comment API refuses
 * it: a media node carrying the numeric attachment id comes back
 * `400 ATTACHMENT_VALIDATION_ERROR`, whatever the surrounding shape. Checked
 * against the live instance — with and without `collection`, with and without
 * width and height, inside `mediaSingle` and inside `mediaGroup`, and for a
 * PNG as well as the video. Omitting `collection` swaps the error for
 * `INVALID_INPUT`, so the field is required and the id is still refused.
 *
 * The node wants a Media Services UUID rather than the attachment id, and
 * nothing in the public API hands one out — `/rest/api/3/attachment/{id}`
 * returns filename, size, content URL and no media id.
 *
 * So the comment names the file and the file lives in the card's Attachments
 * panel. That was always the fallback; it is now the only path.
 */

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: 'doc', version: 1, content }
}
