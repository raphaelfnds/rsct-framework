const SPEC_LABEL_LIMIT = 200

export const DIALOG_PATH_LIMIT = 1000

export const DIALOG_UNCUT = Number.POSITIVE_INFINITY

const LINE_BREAK_CODES = [10, 11, 12, 13, 0x85, 0x2028, 0x2029]

const BREAK_RUNS = new RegExp(`[${String.fromCharCode(9, ...LINE_BREAK_CODES)}]+`, 'g')

const MESSAGE_BREAKS = new RegExp(`${String.fromCharCode(13, 10)}|[${String.fromCharCode(...LINE_BREAK_CODES)}]`, 'g')

const FORMAT = /\p{Cf}/gu

const CONTROL = /\p{Cc}/gu

const HIDDEN = /[\p{Cc}\p{Cf}]/gu

const SHOWN_HIDDEN = String.fromCharCode(0xfffd)

const MARK_PILE = /(\p{M}{4})\p{M}+/gu

export function specLabel(text: string, limit: number = SPEC_LABEL_LIMIT): string {
  const flat = text.replace(FORMAT, '').replace(BREAK_RUNS, ' ').replace(CONTROL, '').replace(MARK_PILE, '$1')
  const points = Array.from(flat)
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : flat
}

export function dialogList(items: readonly string[], limit: number, width: number = SPEC_LABEL_LIMIT): string {
  const head = items.slice(0, limit).map((item) => `• ${specLabel(item, width)}`)
  if (items.length > limit) head.push(`… and ${items.length - limit} more`)
  return head.join('\n')
}

export function commitMessageView(message: string): string {
  const kept: string[] = []
  for (const raw of message.replace(MESSAGE_BREAKS, '\n').split('\n')) {
    const line = raw.replace(/\t/g, ' ').replace(HIDDEN, SHOWN_HIDDEN).replace(MARK_PILE, `$1${SHOWN_HIDDEN}`).trimEnd()
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}
