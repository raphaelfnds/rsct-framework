import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import pino from 'pino'

import { statusTool, statusHandler } from './tools/status.js'
import { loadContextTool, loadContextHandler } from './tools/load-context.js'
import { getDecisionsTool, getDecisionsHandler } from './tools/get-decisions.js'
import { getKnowledgeTool, getKnowledgeHandler } from './tools/get-knowledge.js'
import {
  getEnvironmentsTool,
  getEnvironmentsHandler,
} from './tools/get-environments.js'
import {
  getArchitectureTool,
  getArchitectureHandler,
} from './tools/get-architecture.js'
import { getUniverseTool, getUniverseHandler } from './tools/get-universe.js'
import { getTopologyTool, getTopologyHandler } from './tools/get-topology.js'
import {
  detectOnboardingTool,
  detectOnboardingHandler,
} from './tools/detect-onboarding.js'
import {
  checkPremiseTool,
  checkPremiseHandler,
} from './tools/check-premise.js'
import { checkBranchTool, checkBranchHandler } from './tools/check-branch.js'
import { checkSecretsTool, checkSecretsHandler } from './tools/check-secrets.js'
import {
  checkEditScopeTool,
  checkEditScopeHandler,
} from './tools/check-edit-scope.js'
import {
  requestCommitTool,
  requestCommitHandler,
} from './tools/request-commit.js'
import {
  requestPushTool,
  requestPushHandler,
} from './tools/request-push.js'
import {
  requestMergeTool,
  requestMergeHandler,
} from './tools/request-merge.js'
import {
  planAuthorizeTool,
  planAuthorizeHandler,
} from './tools/plan-authorize.js'
import {
  planRevokeTool,
  planRevokeHandler,
} from './tools/plan-revoke.js'
import {
  phaseVerificationStartTool,
  phaseVerificationStartHandler,
} from './tools/phase-verification-start.js'
import {
  phaseVerificationCompleteTool,
  phaseVerificationCompleteHandler,
} from './tools/phase-verification-complete.js'
import {
  classifyTaskTool,
  classifyTaskHandler,
} from './tools/classify-task.js'
import { phaseStatusTool, phaseStatusHandler } from './tools/phase-status.js'
import {
  phaseResearchStartTool,
  phaseResearchStartHandler,
} from './tools/phase-research-start.js'
import {
  phaseResearchCompleteTool,
  phaseResearchCompleteHandler,
} from './tools/phase-research-complete.js'
import {
  phaseSpecStartTool,
  phaseSpecStartHandler,
} from './tools/phase-spec-start.js'
import {
  phaseSpecCompleteTool,
  phaseSpecCompleteHandler,
} from './tools/phase-spec-complete.js'
import {
  phaseCodeStartTool,
  phaseCodeStartHandler,
} from './tools/phase-code-start.js'
import {
  phaseCodeCompleteTool,
  phaseCodeCompleteHandler,
} from './tools/phase-code-complete.js'
import {
  phaseTestStartTool,
  phaseTestStartHandler,
} from './tools/phase-test-start.js'
import {
  phaseTestCompleteTool,
  phaseTestCompleteHandler,
} from './tools/phase-test-complete.js'
import {
  phaseAbandonTool,
  phaseAbandonHandler,
} from './tools/phase-abandon.js'
import {
  captureIssueTool,
  captureIssueHandler,
} from './tools/capture-issue.js'
import {
  personaReviewTool,
  personaReviewHandler,
} from './tools/persona-review.js'
import {
  autoPersonaTool,
  autoPersonaHandler,
} from './tools/auto-persona.js'
import { tutorStepTool, tutorStepHandler } from './tools/tutor-step.js'
import { RESOURCE_TEMPLATES, STATIC_RESOURCES, readResource } from './resources.js'
import { RSCT_MCP_VERSION } from './lib/version.js'

const SERVER_NAME = 'rsct-mcp'
const SERVER_VERSION = RSCT_MCP_VERSION

const logger = pino(
  {
    level: process.env.RSCT_LOG_LEVEL ?? 'info',
    base: { name: SERVER_NAME, version: SERVER_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
)

type ToolHandler = (args: unknown) => Promise<unknown>

const TOOLS: Tool[] = [
  statusTool,
  loadContextTool,
  getDecisionsTool,
  getKnowledgeTool,
  getEnvironmentsTool,
  getArchitectureTool,
  getUniverseTool,
  getTopologyTool,
  detectOnboardingTool,
  checkPremiseTool,
  checkBranchTool,
  checkSecretsTool,
  checkEditScopeTool,
  requestCommitTool,
  requestPushTool,
  requestMergeTool,
  planAuthorizeTool,
  planRevokeTool,
  classifyTaskTool,
  phaseStatusTool,
  phaseResearchStartTool,
  phaseResearchCompleteTool,
  phaseSpecStartTool,
  phaseSpecCompleteTool,
  phaseVerificationStartTool,
  phaseVerificationCompleteTool,
  phaseCodeStartTool,
  phaseCodeCompleteTool,
  phaseTestStartTool,
  phaseTestCompleteTool,
  phaseAbandonTool,
  captureIssueTool,
  personaReviewTool,
  autoPersonaTool,
  tutorStepTool,
]

const HANDLERS: Record<string, ToolHandler> = {
  rsct_status: statusHandler,
  rsct_load_context: loadContextHandler,
  rsct_get_decisions: getDecisionsHandler,
  rsct_get_knowledge: getKnowledgeHandler,
  rsct_get_environments: getEnvironmentsHandler,
  rsct_get_architecture: getArchitectureHandler,
  rsct_get_universe: getUniverseHandler,
  rsct_get_topology: getTopologyHandler,
  rsct_detect_onboarding: detectOnboardingHandler,
  rsct_check_premise: checkPremiseHandler,
  rsct_check_branch: checkBranchHandler,
  rsct_check_secrets: checkSecretsHandler,
  rsct_check_edit_scope: checkEditScopeHandler,
  rsct_request_commit: requestCommitHandler,
  rsct_request_push: requestPushHandler,
  rsct_request_merge: requestMergeHandler,
  rsct_plan_authorize: planAuthorizeHandler,
  rsct_plan_revoke: planRevokeHandler,
  rsct_classify_task: classifyTaskHandler,
  rsct_phase_status: phaseStatusHandler,
  rsct_phase_research_start: phaseResearchStartHandler,
  rsct_phase_research_complete: phaseResearchCompleteHandler,
  rsct_phase_spec_start: phaseSpecStartHandler,
  rsct_phase_spec_complete: phaseSpecCompleteHandler,
  rsct_phase_verification_start: phaseVerificationStartHandler,
  rsct_phase_verification_complete: phaseVerificationCompleteHandler,
  rsct_phase_code_start: phaseCodeStartHandler,
  rsct_phase_code_complete: phaseCodeCompleteHandler,
  rsct_phase_test_start: phaseTestStartHandler,
  rsct_phase_test_complete: phaseTestCompleteHandler,
  rsct_phase_abandon: phaseAbandonHandler,
  rsct_capture_issue: captureIssueHandler,
  rsct_persona_review: personaReviewHandler,
  rsct_auto_persona: autoPersonaHandler,
  rsct_tutor_step: tutorStepHandler,
}

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const handler = HANDLERS[name]
    if (!handler) {
      logger.warn({ name }, 'unknown tool requested')
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `unknown tool: ${name}` }) },
        ],
        isError: true,
      }
    }

    try {
      const result = await handler(request.params.arguments ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ name, err }, 'tool handler threw')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message, tool: name }),
          },
        ],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }))

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    try {
      const result = readResource(uri)
      return {
        contents: [
          {
            uri: result.uri,
            mimeType: result.mimeType,
            text: result.text,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ uri, err }, 'resource read failed')
      throw new Error(message)
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info(
    {
      tools: TOOLS.map((t) => t.name),
      resources: STATIC_RESOURCES.map((r) => r.uri),
      resource_templates: RESOURCE_TEMPLATES.map((r) => r.uriTemplate),
    },
    'rsct-mcp ready',
  )
}

main().catch((err) => {
  logger.fatal({ err }, 'rsct-mcp failed to start')
  process.exit(1)
})
