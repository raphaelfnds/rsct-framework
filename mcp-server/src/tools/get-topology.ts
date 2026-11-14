import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod/v3'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { detectTopology, type TopologyBlock } from '../lib/topology.js'
import {
  readContracts,
  contractsProducedBy,
  contractsConsumedBy,
  affectedConsumers,
  unregisteredNames,
  type Contract,
  type ContractGraph,
} from '../lib/contracts.js'
import { readUniverse } from '../lib/universe.js'
import { FIRST_RECORD_LINE, gatherContractFacts } from '../lib/contract-facts.js'
import { defaultGitExecutor } from '../lib/git.js'
import { toPosix } from '../lib/phase-scope.js'
import type { RsctConfig } from '../lib/project-root.js'

const PATHS_DESCRIPTION =
  'Optional files you plan to change, relative to the project root or absolute. The answer (paths_check) lists the contracts whose surface they touch and the declared consumers, read the way V and the commit gate read them: every .rsct.json app name, and in each linked universe its working tree, HEAD and fetched upstream. It never records the universe baseline. Importers and impact docs stay in the V phase (rsct_phase_verification_start). A folder and a path outside the project root are reported as such, never as untouched.'

export const getTopologyInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    paths: z.array(z.string().min(1)).max(500).optional().describe(PATHS_DESCRIPTION),
  })
  .strict()

export type GetTopologyInput = z.infer<typeof getTopologyInputSchema>

export interface GetTopologyOutput {
  rsct_installed: boolean
  app_name: string | null
  universe_available: boolean
  universe_path: string | null
  topology: TopologyBlock
  contracts: ContractGraph
  /** Contracts this app PRODUCES (its surfaces are gated on commit in multi-repo). */
  produced: Contract[]
  /** Contracts this app CONSUMES (it depends on another app's surface). */
  consumed: Contract[]
  paths_check?: PathsCheck
  hints: string[]
}

export interface PathsCheck {
  paths: string[]
  folders: string[]
  outside_root: string[]
  app_names: string[]
  universe_linked: boolean
  contracts_readable: boolean
  contracts_touched: Contract[]
  consumers: string[]
  notes: string[]
}

export const getTopologyTool: Tool = {
  name: 'rsct_get_topology',
  description:
    "Reports the project's repo TOPOLOGY (mono / monorepo / multi-repo — inferred + dev-confirmed) and the org-level CONTRACT GRAPH from the linked universe's contracts.json: the contracts this app produces (its surfaces) and consumes (its dependencies). In multi-repo mode, rsct_request_commit BLOCKS a commit that touches a produced contract surface (listing the affected consumers) unless dev_approval.override_contract_surface is given. Call this when rsct_status reports topology multi-repo, before changing shared API/schema/event surfaces, to see who depends on them. Pass paths to see which contracts the files you plan to change touch (paths_check), read the way V and the commit gate read them. Always succeeds; degrades to a hint when no universe / no contracts.json is present.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      paths: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 500,
        description: PATHS_DESCRIPTION,
      },
    },
    additionalProperties: false,
  },
}

export async function getTopologyHandler(rawInput: unknown): Promise<GetTopologyOutput> {
  const input = getTopologyInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const appName = resolution.config?.app?.name ?? null

  // Single source: detectTopology computes the block + resolves the universe root
  // (+ the FV1 inactive-gate hint). Contracts are read on demand (payload).
  const { block, universe_root, hint } = detectTopology(resolution.config, resolution.root)
  const contracts = readContracts(universe_root)
  const produced = contractsProducedBy(contracts, appName)
  const consumed = contractsConsumedBy(contracts, appName)

  const hints: string[] = []
  if (!resolution.rsct_installed) {
    hints.push(
      'No .rsct.json in this project — run /rsct-setup. Topology detection + contract enforcement need an rsct-managed project.',
    )
  }
  // FV1 — the inactive-gate hint (multi-repo confirmed but no universe / no manifest).
  if (hint) hints.push(hint)
  if (resolution.rsct_installed && block.confirmed_mode === null) {
    hints.push(
      `Topology not yet confirmed (inferred '${block.inferred_mode}', confidence ${block.confidence}). Run /rsct-setup to confirm + persist it — the contract gate stays OFF until a 'multi-repo' mode is confirmed.`,
    )
  }
  // RV2: a confirmed non-multi-repo mode that CONTRADICTS a high-confidence
  // multi-repo inference silently turns the gate off — surface it (the FV1
  // philosophy: a silently-off gate is never silent).
  if (
    block.confirmed_mode !== null &&
    block.confirmed_mode !== 'multi-repo' &&
    block.inferred_mode === 'multi-repo' &&
    block.confidence === 'high'
  ) {
    hints.push(
      `Topology is confirmed '${block.confirmed_mode}' but the signals strongly suggest 'multi-repo' (${block.signals.registered_apps_count} registered apps in an external universe) — the contract gate is OFF. If this repo is multi-repo, re-run /rsct-setup to confirm it.`,
    )
  }
  if (block.confirmed_mode === 'multi-repo' && contracts.available && produced.length > 0) {
    const consumers = affectedConsumers(produced)
    hints.push(
      `This app produces ${produced.length} contract(s); ${consumers.length} consumer app(s) depend on its surfaces (${consumers.join(', ') || 'none listed'}). This repo is the PRODUCER, so rsct_request_commit blocks commits HERE that touch those surfaces unless dev_approval.override_contract_surface is given.`,
    )
  }
  // The consumer's-eye view: a repo that only CONSUMES contracts often expects the
  // gate to protect IT — but the gate is producer-side. Say so, so a consumer-side
  // installer isn't left wondering why the gate never fires (field-report friction).
  if (
    block.confirmed_mode === 'multi-repo' &&
    contracts.available &&
    produced.length === 0 &&
    consumed.length > 0
  ) {
    hints.push(
      `This app only CONSUMES contracts (it produces none of the ${consumed.length} it depends on). The contract gate protects the repo that PUBLISHES a surface — the producer — not the consumer, so it never blocks commits here. That's expected; nothing to configure.`,
    )
  }
  // Name-mismatch warnings (DX-5 + PH-2) — fire whenever computable (any topology
  // mode): a producer / consumer / app.name that matches no registered app the way
  // the gate compares (`===`, case-SENSITIVE) can never gate/match. A case-only typo
  // is the worst case — it looks right but the gate silently treats it as
  // unregistered. Re-read the universe here: the registered NAME arrays don't escape
  // universe.ts — getUniverse/TopologyBlock expose only the count (§9.A). readUniverse
  // may still return null on a degraded-but-resolvable universe → that null is the guard.
  if (contracts.available && universe_root) {
    const universe = readUniverse(universe_root)
    if (universe) {
      // Union dirs∪json mirrors `this_app_registered = inDirs || inJson` (universe.ts).
      const registered = [...universe.registeredFromDirs, ...universe.registeredFromJson]
      if (registered.length === 0) {
        // Empty registry → EVERY name is trivially unregistered; emit ONE summary
        // instead of a wall of per-name hints (V-P2-G — amplified now by consumers).
        hints.push(
          `The universe has no registered apps (empty applications/ + registered_apps[]), so no contract producer/consumer can be validated — register the apps by running /rsct-setup in each.`,
        )
      } else {
        // (1) producers
        for (const issue of unregisteredNames(
          contracts.contracts.map((c) => c.producer),
          registered,
        )) {
          if (issue.kind === 'case_mismatch') {
            hints.push(
              `Contract producer '${issue.name}' looks like the registered app '${issue.suggestion}' but the case differs — the contract gate matches names exactly (case-sensitive), so this contract will never gate. Fix the case in contracts.json to '${issue.suggestion}'.`,
            )
          } else {
            hints.push(
              `Contract producer '${issue.name}' matches no registered app in the universe — that contract will never gate. Register the app (run /rsct-setup in it) or fix the producer name in contracts.json.`,
            )
          }
        }
        // (2) consumers (PH-2 net-new) — flat across all contracts, deduped by the classifier.
        for (const issue of unregisteredNames(
          contracts.contracts.flatMap((c) => c.consumers),
          registered,
        )) {
          if (issue.kind === 'case_mismatch') {
            hints.push(
              `Contract consumer '${issue.name}' looks like the registered app '${issue.suggestion}' but the case differs — names are matched exactly, so this consumer relationship won't be recognized. Fix the case in contracts.json to '${issue.suggestion}'.`,
            )
          } else {
            hints.push(
              `Contract consumer '${issue.name}' matches no registered app in the universe — that consumer relationship won't be recognized. Register the app (run /rsct-setup in it) or fix the consumer name in contracts.json.`,
            )
          }
        }
        // (3) app.name (PH-2 — the load-bearing one): the gate's LEFT operand is raw
        // config.app.name. If it's registered under a DIFFERENT case, the gate silently
        // never fires for THIS repo's own commits. Only case_mismatch is a bug here — an
        // outright-unregistered app.name is just "not registered yet" (surfaced elsewhere).
        if (appName) {
          for (const issue of unregisteredNames([appName], registered)) {
            if (issue.kind === 'case_mismatch') {
              hints.push(
                `Your app.name '${issue.name}' is registered in the universe as '${issue.suggestion}' (the case differs). The contract gate matches names exactly (case-sensitive), so it will never fire for THIS repo's own commits. Fix app.name in .rsct.json to '${issue.suggestion}' (or re-register the app).`,
              )
            }
          }
        }
      }
    }
  }
  if (contracts.note) hints.push(`contracts.json: ${contracts.note}.`)

  const pathsCheck = input.paths === undefined ? undefined : checkPaths(resolution.root, resolution.config, input.paths)
  if (pathsCheck !== undefined) hints.push(describePathsCheck(pathsCheck))

  return {
    rsct_installed: resolution.rsct_installed,
    app_name: appName,
    universe_available: block.signals.universe_available,
    universe_path: universe_root,
    topology: block,
    contracts,
    produced,
    consumed,
    ...(pathsCheck !== undefined && { paths_check: pathsCheck }),
    hints,
  }
}

function checkPaths(root: string, config: RsctConfig | null, paths: readonly string[]): PathsCheck {
  const rel = [...new Set(paths.map((p) => toPosix(relative(root, isAbsolute(p) ? p : resolve(root, p)))))]
  const outside = rel.filter((p) => p === '..' || p.startsWith('../') || isAbsolute(p))
  const folders = rel.filter((p) => !outside.includes(p) && (p === '' || isFolder(resolve(root, p))))
  const files = rel.filter((p) => !outside.includes(p) && !folders.includes(p))
  const facts = gatherContractFacts({
    projectRoot: root,
    config,
    readPaths: () => files,
    executor: defaultGitExecutor,
    always: true,
    ...(config?.audit !== undefined && { auditConfig: config.audit }),
  })
  return {
    paths: files,
    folders: folders.map((p) => (p === '' ? '.' : p)),
    outside_root: outside,
    app_names: facts?.apps ?? [],
    universe_linked: facts?.universeLinked ?? false,
    contracts_readable: facts !== null && facts.universeLinked && !facts.inactive,
    contracts_touched: facts?.hits ?? [],
    consumers: facts?.consumers ?? [],
    notes: (facts?.lines ?? []).filter((line) => line !== FIRST_RECORD_LINE),
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function describePathsCheck(check: PathsCheck): string {
  const outside = check.outside_root.length > 0 ? ` ${check.outside_root.length} path(s) are outside the project root and are not matched against any surface: ${check.outside_root.join(', ')}.` : ''
  const folders = check.folders.length > 0 ? ` ${check.folders.length} path(s) are folders, and surfaces are matched against files, so list the files you plan to change in them: ${check.folders.join(', ')}.` : ''
  const unmatched = `${folders}${outside}`
  if (!check.universe_linked) return `paths_check: no universe resolves for this project, so contracts do not apply here (not "none touched").${unmatched}`
  if (!check.contracts_readable) return `paths_check: no contracts.json of the linked universe could be read, so whether these paths touch a contract is UNKNOWN.${unmatched}`
  if (check.app_names.length === 0) return `paths_check: no .rsct.json names an app.name, so no surface can match and whether these paths touch a contract is UNKNOWN.${unmatched}`
  const ids = check.contracts_touched.map((c) => c.id).join(', ')
  const touched =
    check.contracts_touched.length > 0
      ? `${check.contracts_touched.length} contract(s) touched (${ids}); declared consumers: ${check.consumers.join(', ') || 'none listed'}.`
      : check.paths.length > 0
        ? 'No declared contract surface is touched by the files given.'
        : 'No file was given to match.'
  return `paths_check: ${touched} Read the way V and the commit gate read contracts; importers and impact docs stay in the V phase.${unmatched}`
}
