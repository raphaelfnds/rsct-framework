import { z } from 'zod'
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

export const getTopologyInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
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
  hints: string[]
}

export const getTopologyTool: Tool = {
  name: 'rsct_get_topology',
  description:
    "Reports the project's repo TOPOLOGY (mono / monorepo / multi-repo — inferred + dev-confirmed) and the org-level CONTRACT GRAPH from the linked universe's contracts.json: the contracts this app produces (its surfaces) and consumes (its dependencies). In multi-repo mode, rsct_request_commit BLOCKS a commit that touches a produced contract surface (listing the affected consumers) unless dev_approval.override_contract_surface is given. Call this when rsct_status reports topology multi-repo, before changing shared API/schema/event surfaces, to see who depends on them. Always succeeds; degrades to a hint when no universe / no contracts.json is present.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
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

  return {
    rsct_installed: resolution.rsct_installed,
    app_name: appName,
    universe_available: block.signals.universe_available,
    universe_path: universe_root,
    topology: block,
    contracts,
    produced,
    consumed,
    hints,
  }
}
