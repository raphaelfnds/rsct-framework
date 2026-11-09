import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIALOG_PATH_LIMIT, DIALOG_UNCUT, dialogList, specLabel } from './dialog-text.js'
import type { SecretFinding } from './secrets.js'

export const DIALOG_LIST_SHOWN = 10

export interface OverrideReason {
  reason: string
}

export function writeListReport(projectRoot: string, tool: string, kind: string, title: string, entries: readonly string[]): string | null {
  const content = [`# ${title}`, '', ...entries.map((e) => `- ${e}`), ''].join('\n')
  const rel = join('.rsct', 'reports', `${tool}-${kind}-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.md`)
  try {
    mkdirSync(join(projectRoot, '.rsct', 'reports'), { recursive: true })
    writeFileSync(join(projectRoot, rel), content, 'utf8')
    return rel.replace(/\\/g, '/')
  } catch {
    return null
  }
}

export function quoted(text: string): string {
  return `"${specLabel(text)}"`
}

export function inlineList(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).map(quoted).join(', ')
  return items.length > limit ? `${shown} … and ${items.length - limit} more` : shown
}

export function shownLimit(report: string | null): number {
  return report === null ? DIALOG_UNCUT : DIALOG_LIST_SHOWN
}

function findingRule(finding: SecretFinding): string {
  return finding.reason === 'extra-pattern' ? `extra pattern ${finding.pattern_id ?? '?'}` : finding.reason
}

export function findingLabel(finding: SecretFinding): string {
  const commit = finding.commit !== undefined ? ` (commit ${finding.commit.slice(0, 12)})` : ''
  return `"${finding.file}":${finding.line_number ?? '?'} — ${findingRule(finding)}${commit}`
}

export function findingIdentity(finding: SecretFinding): string {
  return JSON.stringify([finding.file, findingRule(finding), finding.excerpt])
}

export function protectedBranchLine(branchLabel: string, doing: string): string {
  return `⚠ '${specLabel(branchLabel, DIALOG_PATH_LIMIT)}' is a protected branch: ${doing} needs your exception.`
}

export function secretFindingLines(projectRoot: string, tool: string, findings: readonly SecretFinding[]): string[] {
  if (findings.length === 0) return []
  const lines = [`⚠ The secrets scan found ${findings.length} line(s) that look like a credential (file:line — rule; values are never shown):`]
  const report =
    findings.length > DIALOG_LIST_SHOWN
      ? writeListReport(projectRoot, tool, 'secrets', `Secret scan findings for one ${tool} approval`, findings.map((f) => `${findingLabel(f)} — ${f.excerpt}`))
      : null
  lines.push(dialogList(findings.map(findingLabel), shownLimit(report)))
  if (report !== null) lines.push(`Full list: ${report}`)
  return lines
}

export interface FindingAction {
  finding_id: string
  action: string
  note?: string | undefined
}

export function findingActionLines(
  projectRoot: string,
  tool: string,
  actions: readonly FindingAction[],
  titleOf: (id: string) => string | undefined,
): { facts: string[]; agent: string[] } {
  if (actions.length === 0) return { facts: [], agent: [] }
  const full = (a: FindingAction, i: number): string => {
    const title = titleOf(a.finding_id)
    return `#${i + 1} ${a.finding_id} [${a.action}]${title ? ` ${title}` : ''}${a.note ? ` — note: ${a.note}` : ''}`
  }
  const report =
    actions.length > DIALOG_LIST_SHOWN
      ? writeListReport(projectRoot, tool, 'findings', `Findings and the agent's actions for one ${tool} approval`, actions.map(full))
      : null
  const shown = report === null ? actions : actions.slice(0, DIALOG_LIST_SHOWN)
  const facts = [`Findings and the action the agent proposes for each (${actions.length}):`, ...shown.map((a, i) => `#${i + 1} [${a.action}]`)]
  if (shown.length < actions.length) facts.push(`… and ${actions.length - shown.length} more — full list: ${report}`)
  const agent = shown.map((a, i) => {
    const title = titleOf(a.finding_id)
    return `#${i + 1} ${specLabel(a.finding_id, 60)}${title ? ` — ${specLabel(title, 80)}` : ''}${a.note ? ` — note: ${specLabel(a.note, 80)}` : ''}`
  })
  return { facts, agent: ['What the agent wrote for each finding:', ...agent] }
}

export function agentReasonLine(what: string, override: OverrideReason | undefined): string[] {
  return override === undefined ? [] : [`Agent's reason for ${what}: ${quoted(override.reason)}`]
}
