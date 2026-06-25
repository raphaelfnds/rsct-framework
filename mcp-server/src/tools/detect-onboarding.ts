import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { detectOnboarding, type OnboardingDetection } from '../lib/onboarding-detect.js'

export const detectOnboardingInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
  })
  .strict()

export type DetectOnboardingInput = z.infer<typeof detectOnboardingInputSchema>

export interface DetectOnboardingOutput extends OnboardingDetection {
  rsct_installed: boolean
}

export const detectOnboardingTool: Tool = {
  name: 'rsct_detect_onboarding',
  description:
    "Onboarding orchestrator brain for /rsct-setup: classifies the SITUATION (is-universe / has-universe-linked / has-universe-unlinked / universe-configured-missing / offer-register / siblings-no-universe / solo) and the recommended ROUTE (guard-universe-repo / offer-link-existing / offer-create-universe / fix-universe-link / none). Reports is_universe_repo (the deterministic universe≠app guard — if true, STOP setup: this is a governance repo, not an app) and same-org SIBLING apps found one level up (read-only `../` scan; rsct_json matches drive the 'create a universe?' suggestion, git_remote matches are advisory). /rsct-setup calls this once at discovery, then narrates + consent-gates the guided flow. Always succeeds; degrades to 'solo' when nothing applies.",
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

export async function detectOnboardingHandler(rawInput: unknown): Promise<DetectOnboardingOutput> {
  const input = detectOnboardingInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const detection = detectOnboarding(resolution.config, resolution.root)
  return { rsct_installed: resolution.rsct_installed, ...detection }
}
