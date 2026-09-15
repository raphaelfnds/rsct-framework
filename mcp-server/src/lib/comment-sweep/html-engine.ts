import { parse, parseFragment } from 'parse5'

export interface HtmlComment {
  start: number
  end: number
}

export interface HtmlInline {
  kind: 'script' | 'style' | 'script_data' | 'script_other'
  start: number
  end: number
}

export interface HtmlScan {
  comments: HtmlComment[]
  inline: HtmlInline[]
}

interface Location {
  startOffset: number
  endOffset: number
}

interface Node {
  nodeName: string
  tagName?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: Node[]
  content?: Node
  data?: string
  value?: string
  sourceCodeLocation?: (Location & { startTag?: Location; endTag?: Location }) | null
}

const JS_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jsx',
  'text/babel',
])

const DATA_TYPES = new Set(['application/json', 'application/ld+json', 'importmap', 'speculationrules'])

function scriptKind(node: Node): HtmlInline['kind'] {
  const type = node.attrs?.find((a) => a.name === 'type')?.value.trim().toLowerCase() ?? ''
  if (JS_TYPES.has(type)) return 'script'
  return DATA_TYPES.has(type) ? 'script_data' : 'script_other'
}

function walk(node: Node, out: HtmlScan): void {
  if (node.nodeName === '#comment' && node.sourceCodeLocation) {
    const { startOffset, endOffset } = node.sourceCodeLocation
    out.comments.push({ start: startOffset, end: endOffset })
    return
  }
  if ((node.tagName === 'script' || node.tagName === 'style') && node.sourceCodeLocation) {
    for (const text of node.childNodes?.filter((c) => c.nodeName === '#text') ?? []) {
      if (!text.sourceCodeLocation) continue
      out.inline.push({
        kind: node.tagName === 'style' ? 'style' : scriptKind(node),
        start: text.sourceCodeLocation.startOffset,
        end: text.sourceCodeLocation.endOffset,
      })
    }
    return
  }
  for (const child of node.childNodes ?? []) walk(child, out)
  if (node.content) walk(node.content, out)
}

export function scanHtml(source: string, asFragment = false): HtmlScan {
  const out: HtmlScan = { comments: [], inline: [] }
  const doc = (asFragment
    ? parseFragment(source, { sourceCodeLocationInfo: true })
    : parse(source, { sourceCodeLocationInfo: true })) as unknown as Node
  walk(doc, out)
  return out
}
