/**
 * Reading Jira's document format (ADF) back as text: card descriptions and
 * comments arrive as a tree of nodes, and prompts and commands want words.
 */

/** Flattens an ADF document to plain text, for putting card content in a prompt. */
export function adfToText(node: unknown): string {
  return flatten(node, true)
}

/**
 * How a block node's flattened children are laid out.
 *
 * A Map rather than an object literal, so a node whose `type` happens to be
 * `constructor` or `toString` falls through to the default like any other
 * unknown type instead of finding something on the prototype.
 */
const LAYOUT = new Map<unknown, (inner: string) => string>([
  ['paragraph', (inner) => `${inner}\n`],
  ['heading', (inner) => `${inner}\n`],
  ['listItem', (inner) => `- ${inner.trim()}\n`],
  ['hardBreak', () => '\n'],
])

/**
 * A mention as text: its display name, or nothing at all when the caller wants
 * what was said rather than to whom.
 */
function mentionText(n: Record<string, unknown>, mentions: boolean): string {
  if (!mentions) return ''
  const label = (n['attrs'] as { text?: unknown } | undefined)?.text
  return typeof label === 'string' && label !== '' ? label : '@someone'
}

function flatten(node: unknown, mentions: boolean): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node

  const n = node as Record<string, unknown>
  if (n['type'] === 'text' && typeof n['text'] === 'string') return n['text']
  if (n['type'] === 'mention') return mentionText(n, mentions)

  const children = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  const inner = children.map((child) => flatten(child, mentions)).join('')
  const layout = LAYOUT.get(n['type'])
  return layout === undefined ? inner : layout(inner)
}

/** The body with every @mention left out: what was said, not to whom. */
export function textWithoutMentions(node: unknown): string {
  return flatten(node, false)
}

/** Every account id @mentioned anywhere in an ADF document, in order. */
export function mentionedIds(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const n = node as Record<string, unknown>
  const id = (n['attrs'] as { id?: unknown } | undefined)?.id
  const own = n['type'] === 'mention' && typeof id === 'string' && id !== '' ? [id] : []
  const children = Array.isArray(n['content']) ? (n['content'] as unknown[]) : []
  return [...own, ...children.flatMap(mentionedIds)]
}
