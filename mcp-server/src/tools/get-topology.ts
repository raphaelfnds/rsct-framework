import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { detectTopology, type TopologyBlock } from '../lib/topology.js'
import {
  readContracts,
  contractsProducedBy,
  contractsConsumedBy,
  affectedConsumers,
  type Contract,
  type ContractGraph,
} from '../lib/contracts.js'

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
