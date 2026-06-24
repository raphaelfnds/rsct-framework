import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { z } from 'zod'
import { appendAuditEntry } from './audit-log.js'

export interface RsctApprovalModes {
  timestamp_skew_seconds?: number
  fabrication_signal_threshold_ms?: number
  trust_allowed_for?: string[]
  /** T3: default TTL (minutes) for a plan-authorization token. Bounds 5–480. */
  plan_token_ttl_minutes?: number
  /** T3: default max commits a plan-authorization token covers. Bounds 1–100. */
  plan_token_max_actions?: number
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
  /**
   * T2 — the repo topology, confirmed by the dev at /rsct-setup. The
   * contract-surface gate (INV-7) diverges ONLY on `mode === 'multi-repo'`.
   * Additive (Zod top-level `.strip()` keeps older servers tolerant).
   */
  topology?: {
    mode: 'mono' | 'monorepo' | 'multi-repo'
    confirmed_at?: string
    detected_signals?: string[]
  }
  protected_branches?: string[]
  test_framework?: string
  install?: {
    applied_at?: string
    mode?: string
    setup_commit_sha_before?: string
    canonical_source_added?: boolean
    /** DX-1b: ISO timestamp set when the dev declines the create-universe offer (ask-once). */
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

// Bounds for HIGH-4 defense (M2 audit). Defends against `.rsct.json`
// config-side bypass: an attacker (Claude itself, a malicious dep, a
// supply-chain hook) edits the config to disable enforcement (audit off,
// skew=infinity, protected_branches=[], or trust_allowed_for=*) and the
// loader trusts it. Strict bounds on every dangerous field; out-of-bounds
// load is rejected (returns null = same surface as missing config) AND a
// `rsct_json.bounds_violation` event is forced into the audit log so the
// dev can see what happened.

const TRUST_ALLOWED_TOOL_NAMES = [
  'rsct_request_commit',
  'rsct_request_push',
  'rsct_request_merge',
  'rsct_phase_verification_complete',
  'rsct_phase_research_complete',
  'rsct_phase_spec_complete',
  'rsct_phase_code_complete',
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
    // T3: strict bounds mirror the HIGH-4 posture — an out-of-range value
    // rejects the whole config (rsct_installed=false) rather than silently
    // granting an over-wide batch window.
    plan_token_ttl_minutes: z.number().int().min(5).max(480).optional(),
    plan_token_max_actions: z.number().int().min(1).max(100).optional(),
  })
  .strict()

const RsctAuditConfigSchema = z
  .object({
    // `false` is the documented bypass vector — schema literal blocks it.
    // Absent or `true` are equivalent (audit defaults on).
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
    // T2: `.strict()` mirrors the HIGH-4 posture — a malformed topology block
    // rejects the whole config (rsct_installed=false → the contract gate can't
    // run) rather than silently mis-driving enforcement. V FV7: keep `.strict()`
    // (a silently dropped `mode` would turn enforcement OFF with no signal —
    // worse); the rejection surfaces via the forced `bounds_violation` audit.
    topology: z
      .object({
        mode: z.enum(['mono', 'monorepo', 'multi-repo']),
        confirmed_at: z.string().optional(),
        detected_signals: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    // `.min(1)`: empty array disables the default protection wholesale and
    // is the HIGH-4 vector. If a project genuinely wants zero protected
    // branches, it should uninstall `.rsct.json`.
    protected_branches: z.array(z.string().min(1)).min(1).optional(),
    test_framework: z.string().optional(),
    install: z
      .object({
        applied_at: z.string().optional(),
        mode: z.string().optional(),
        setup_commit_sha_before: z.string().optional(),
        canonical_source_added: z.boolean().optional(),
        // DX-1b: ask-once flag — ISO timestamp set when the dev declines the
        // create-universe offer, so /rsct-setup doesn't re-ask every run.
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
  // `.strip()`: silently drop unknown top-level keys so adding new
  // optional fields in a future version doesn't break installs running
  // older mcp-servers. Dangerous fields above are individually `.strict()`.
  .strip()

/**
 * Locate the rsct project root.
 *
 * Resolution precedence (highest first):
 *   1. `explicitRoot` — the `input.project_root` tool argument. The schema
 *      documents it as "overrides project root detection", so it wins.
 *   2. Launch override — `--project-root <path>` CLI arg or `RSCT_PROJECT_ROOT`
 *      env var (how the server process was started). Taken as the root directly.
 *   3. `CLAUDE_PROJECT_DIR` env var (set by Claude Code) — the START of an
 *      upward walk. This is what lets the server find the project on
 *      WSL-from-Windows, where the MCP server's cwd is `C:\Windows` (Windows
 *      rejects a UNC cwd) so a plain cwd walk could never reach a
 *      `//wsl.localhost/...` project.
 *   4. `process.cwd()` — final fallback; walk up looking for `.rsct.json`.
 *
 * Any source whose value still carries an unsubstituted `${...}` placeholder
 * (e.g. a `.mcp.json` `args:["--project-root","${workspaceFolder}"]` the
 * launcher never expanded) is REJECTED with a one-time stderr warning rather
 * than `path.resolve`d against the cwd — that silent resolution produced the
 * `C:\Windows\${workspaceFolder}` false-negative (CAP-49 field report).
 *
 * Returns the resolved root even if `.rsct.json` is not found — the tool
 * surface should degrade gracefully (`rsct_installed: false`) rather than fail.
 */
export function resolveProjectRoot(explicitRoot?: string): ProjectRootResolution {
  // 1 + 2: explicit tool arg, then launch override — both taken as the root
  // directly (the historical contract for the override path; tests rely on it).
  const direct =
    sanitizeRoot(explicitRoot, 'project_root argument') ??
    sanitizeRoot(readLaunchOverride(), 'launch override (--project-root / RSCT_PROJECT_ROOT)')
  if (direct) return buildResolution(direct)

  // 3 + 4: CLAUDE_PROJECT_DIR, else cwd — used as the START of an upward walk.
  const claudeDir = sanitizeRoot(process.env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR')
  const startDir = claudeDir ?? resolve(cwd())
  if (claudeDir) {
    // CAP-50 (audit F13): one-time diagnostic so a WSL developer can confirm
    // (in the rsct-mcp stderr log) that auto-detection used CLAUDE_PROJECT_DIR
    // rather than the unreliable cwd (C:\Windows when the server is launched
    // against a //wsl.localhost/... project). Whether Claude Code exposes this
    // var to MCP servers is environment-dependent; this makes the path observable.
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

/**
 * Normalize a candidate root path. Returns `undefined` for empty/whitespace-only
 * values, for values carrying an unsubstituted `${...}` placeholder, and for
 * RELATIVE paths — the schema contract is an ABSOLUTE path, and a relative one
 * would silently resolve against the server cwd (e.g. C:\Windows on WSL), which
 * is never what the caller meant. Each rejection warns once per source so a
 * misconfigured launcher is visible without log spam (CAP-50 audit F4/F6/F14).
 */
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

/**
 * @internal test-only — clears the one-time warn-dedup set (placeholder,
 * relative-path, and CLAUDE_PROJECT_DIR diagnostics) so each test starts from a
 * clean state (the set is process-lived in production).
 */
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
  // Force enabled: true so tamper events survive even when the attack
  // vector was `audit.enabled: false`. The audit path falls back to
  // default `.rsct/audit.log` since the config object is by definition
  // untrusted at this point.
  appendAuditEntry(projectRoot, { event, reason, ...extras }, { enabled: true })
}
