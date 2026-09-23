import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { z } from 'zod'
import { appendAuditEntry } from './audit-log.js'

export interface RsctApprovalModes {
  timestamp_skew_seconds?: number
  fabrication_signal_threshold_ms?: number
  trust_allowed_for?: string[]
  plan_token_ttl_minutes?: number
  plan_token_max_actions?: number
  free_commit_max?: number
  free_commit_max_files?: number
  free_commit_max_lines?: number
  plan_token_ttl_slide_minutes?: number
  plan_token_ttl_abs_minutes?: number
}

export interface RsctAuditConfig {
  enabled?: boolean
  path?: string
}

export interface RsctConfig {
  rsct_version: string
  app: { name: string; org: string }
  universe?: {
    name?: string
    local?: string
    remote?: string
  }
  topology?: {
    mode: 'mono' | 'monorepo' | 'multi-repo'
    confirmed_at?: string
    detected_signals?: string[]
  }
  protected_branches?: string[]
  test_framework?: string
  plan_file_retention?: 'ephemeral' | 'documented'
  commit_message_max_lines?: number
  sql_dialect?: 'postgresql' | 'mysql' | 'none'
  public_api?: string[]
  install?: {
    applied_at?: string
    mode?: string
    setup_commit_sha_before?: string
    canonical_source_added?: boolean
    create_universe_declined_at?: string
  }
  mcp?: {
    server?: string
    version?: string
    registered_at?: string
  }
  approval_modes?: RsctApprovalModes
  audit?: RsctAuditConfig
  protected_patterns_extra?: string[]
  secrets_extra_patterns?: string[]
}

export interface ProjectRootResolution {
  root: string
  rsct_installed: boolean
  config: RsctConfig | null
}

const TRUST_ALLOWED_TOOL_NAMES = [
  'rsct_request_commit',
  'rsct_request_push',
  'rsct_request_merge',
  'rsct_phase_verification_complete',
  'rsct_phase_research_complete',
  'rsct_phase_spec_complete',
  'rsct_phase_code_complete',
  'rsct_phase_review_complete',
  'rsct_phase_test_complete',
  'rsct_phase_abandon',
  'rsct_capture_issue',
  'rsct_plan_authorize',
] as const

const RsctApprovalModesSchema = z
  .object({
    timestamp_skew_seconds: z.number().int().min(60).max(600).optional(),
    fabrication_signal_threshold_ms: z.number().int().min(100).max(5000).optional(),
    trust_allowed_for: z.array(z.enum(TRUST_ALLOWED_TOOL_NAMES)).optional(),
    plan_token_ttl_minutes: z.number().int().min(5).max(480).optional(),
    plan_token_max_actions: z.number().int().min(1).max(100).optional(),
    free_commit_max: z.number().int().min(1).max(50).optional(),
    free_commit_max_files: z.number().int().min(1).max(500).optional(),
    free_commit_max_lines: z.number().int().min(1).max(100000).optional(),
    plan_token_ttl_slide_minutes: z.number().int().min(5).max(1440).optional(),
    plan_token_ttl_abs_minutes: z.number().int().min(5).max(10080).optional(),
  })
  .strip()

const RsctAuditConfigSchema = z
  .object({
    enabled: z.literal(true).optional(),
    path: z.string().min(1).optional(),
  })
  .strict()

const RsctConfigSchema = z
  .object({
    rsct_version: z.string().min(1),
    app: z.object({
      name: z.string().min(1),
      org: z.string().min(1),
    }),
    universe: z
      .object({
        name: z.string().min(1).optional(),
        local: z.string().min(1).optional(),
        remote: z.string().min(1).optional(),
      })
      .optional(),
    topology: z
      .object({
        mode: z.enum(['mono', 'monorepo', 'multi-repo']),
        confirmed_at: z.string().optional(),
        detected_signals: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    protected_branches: z.array(z.string().min(1)).min(1).optional(),
    test_framework: z.string().optional(),
    plan_file_retention: z.enum(['ephemeral', 'documented']).optional(),
    commit_message_max_lines: z.number().optional().catch(undefined),
    sql_dialect: z.enum(['postgresql', 'mysql', 'none']).optional(),
    public_api: z.array(z.string().min(1)).optional().catch(undefined),
    install: z
      .object({
        applied_at: z.string().optional(),
        mode: z.string().optional(),
        setup_commit_sha_before: z.string().optional(),
        canonical_source_added: z.boolean().optional(),
        create_universe_declined_at: z.string().min(1).optional(),
      })
      .optional(),
    mcp: z
      .object({
        server: z.string().optional(),
        version: z.string().optional(),
        registered_at: z.string().optional(),
      })
      .optional(),
    approval_modes: RsctApprovalModesSchema.optional(),
    audit: RsctAuditConfigSchema.optional(),
    protected_patterns_extra: z.array(z.string().min(1)).optional(),
    secrets_extra_patterns: z.array(z.string().min(1)).optional(),
  })
  .strip()

type ExpectNever<T extends never> = T
type _KeysMissingFromSchema = ExpectNever<
  Exclude<keyof RsctConfig, keyof z.infer<typeof RsctConfigSchema>>
>
type _KeysMissingFromInterface = ExpectNever<
  Exclude<keyof z.infer<typeof RsctConfigSchema>, keyof RsctConfig>
>

export function resolveProjectRoot(explicitRoot?: string): ProjectRootResolution {
  const direct =
    sanitizeRoot(explicitRoot, 'project_root argument') ??
    sanitizeRoot(readLaunchOverride(), 'launch override (--project-root / RSCT_PROJECT_ROOT)')
  if (direct) return buildResolution(direct)

  const claudeDir = sanitizeRoot(process.env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR')
  const startDir = claudeDir ?? resolve(cwd())
  if (claudeDir) {
    warnOnce(
      'CLAUDE_PROJECT_DIR:used',
      `resolving project root from CLAUDE_PROJECT_DIR ("${claudeDir}"). Pass an explicit project_root if this is wrong.`,
    )
  }

  let dir = startDir
  while (true) {
    if (existsSync(join(dir, '.rsct.json'))) {
      return buildResolution(dir)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return buildResolution(startDir)
    }
    dir = parent
  }
}

function buildResolution(root: string): ProjectRootResolution {
  const config = readRsctConfig(root)
  return { root, rsct_installed: config !== null, config }
}

const PLACEHOLDER_RE = /\$\{[^}]*\}/
const warnedSources = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedSources.has(key)) return
  warnedSources.add(key)
  process.stderr.write(`[rsct] ${message}\n`)
}

function sanitizeRoot(value: string | undefined, sourceLabel: string): string | undefined {
  if (!value || value.trim().length === 0) return undefined
  if (PLACEHOLDER_RE.test(value)) {
    warnOnce(
      `${sourceLabel}:placeholder`,
      `${sourceLabel} contains an unsubstituted placeholder ("${value}") — ignoring it. ` +
        `Fix the MCP launch config (e.g. .mcp.json): use "args": [] and let the server auto-detect, ` +
        `or pass a real absolute path.`,
    )
    return undefined
  }
  if (!isAbsolute(value)) {
    warnOnce(
      `${sourceLabel}:relative`,
      `${sourceLabel} is a relative path ("${value}") — ignoring it; an absolute path is required ` +
        `(a relative path would resolve against the server cwd, e.g. C:\\Windows on WSL).`,
    )
    return undefined
  }
  return value
}

function readLaunchOverride(): string | undefined {
  const envRoot = process.env.RSCT_PROJECT_ROOT
  if (envRoot && envRoot.length > 0) return envRoot
  const idx = process.argv.indexOf('--project-root')
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]
  }
  return undefined
}

export function __resetPlaceholderWarnings(): void {
  warnedSources.clear()
}

function readRsctConfig(projectRoot: string): RsctConfig | null {
  const path = join(projectRoot, '.rsct.json')
  if (!existsSync(path)) return null

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    emitConfigViolation(projectRoot, 'malformed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const validation = RsctConfigSchema.safeParse(parsed)
  if (!validation.success) {
    emitConfigViolation(projectRoot, 'bounds_violation', {
      validation_errors: validation.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    })
    return null
  }

  return validation.data as RsctConfig
}

type ConfigViolationReason = 'malformed' | 'bounds_violation'

function emitConfigViolation(
  projectRoot: string,
  reason: ConfigViolationReason,
  extras: Record<string, unknown>,
): void {
  const event =
    reason === 'malformed' ? 'rsct_json.malformed' : 'rsct_json.bounds_violation'
  process.stderr.write(
    `[rsct] .rsct.json rejected (${reason}); falling back to rsct_installed=false. See audit log for details.\n`,
  )
  appendAuditEntry(projectRoot, { event, reason, ...extras }, { enabled: true })
}
