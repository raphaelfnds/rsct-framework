import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from './lib/project-root.js'
import { findActivePlan } from './lib/plan.js'

const MIME_MARKDOWN = 'text/markdown'

export const STATIC_RESOURCES: Resource[] = [
  {
    uri: 'rsct://decisions',
    name: 'Decisions',
    description: 'documentation/decisions.md — firm premises + ADRs.',
    mimeType: MIME_MARKDOWN,
  },
  {
    uri: 'rsct://architecture',
    name: 'Architecture overview',
    description: 'documentation/architecture.md — stack, runtime flow, source layout.',
    mimeType: MIME_MARKDOWN,
  },
  {
    uri: 'rsct://plan',
    name: 'Active plan',
    description:
      'The most-recently-modified plan_<slug>.md at project root — the current in-flight work plan.',
    mimeType: MIME_MARKDOWN,
  },
  {
    uri: 'rsct://progress',
    name: 'Active progress',
    description: 'progress_<slug>.md matching the active plan.',
    mimeType: MIME_MARKDOWN,
  },
]

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'rsct://knowledge/{category}',
    name: 'Knowledge category',
    description:
      'documentation/knowledge/{category}.md — institutional knowledge by category (business-rules, anti-decisions, incident-log, etc.).',
    mimeType: MIME_MARKDOWN,
  },
]

export interface ReadResourceResult {
  uri: string
  mimeType: string
  text: string
}

export function readResource(uri: string, projectRoot?: string): ReadResourceResult {
  const root = resolveProjectRoot(projectRoot).root

  if (uri === 'rsct://decisions') {
    return readFileResource(uri, join(root, 'documentation', 'decisions.md'))
  }
  if (uri === 'rsct://architecture') {
    return readFileResource(uri, join(root, 'documentation', 'architecture.md'))
  }
  if (uri === 'rsct://plan') {
    const plan = findActivePlan(root)
    if (!plan) throw notFound(uri, 'no plan_<slug>.md found at project root')
    return readFileResource(uri, plan.plan_path)
  }
  if (uri === 'rsct://progress') {
    const plan = findActivePlan(root)
    if (!plan) throw notFound(uri, 'no active plan, so no matching progress file')
    if (!plan.progress_path) {
      throw notFound(uri, `progress_${plan.slug}.md does not exist next to the active plan`)
    }
    return readFileResource(uri, plan.progress_path)
  }

  const knowledgeMatch = uri.match(/^rsct:\/\/knowledge\/([A-Za-z0-9_-]+)$/)
  if (knowledgeMatch?.[1]) {
    return readFileResource(
      uri,
      join(root, 'documentation', 'knowledge', `${knowledgeMatch[1]}.md`),
    )
  }

  throw notFound(uri, 'URI does not match any rsct:// resource or template')
}

function readFileResource(uri: string, path: string): ReadResourceResult {
  if (!existsSync(path)) throw notFound(uri, `file does not exist: ${path}`)
  const text = readFileSync(path, 'utf8')
  return { uri, mimeType: MIME_MARKDOWN, text }
}

function notFound(uri: string, detail: string): Error {
  return new Error(`Resource not found (${uri}): ${detail}`)
}
