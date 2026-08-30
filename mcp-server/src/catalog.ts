import type { Tool } from '@modelcontextprotocol/sdk/types.js'

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
  planDisposeTool,
  planDisposeHandler,
} from './tools/plan-dispose.js'
import {
  requestRebaseTool,
  requestRebaseHandler,
} from './tools/request-rebase.js'
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
  phaseReviewStartTool,
  phaseReviewStartHandler,
} from './tools/phase-review-start.js'
import {
  phaseReviewCompleteTool,
  phaseReviewCompleteHandler,
} from './tools/phase-review-complete.js'
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
import { auditTool, auditHandler } from './tools/audit.js'

/**
 * #55: the tool catalog, split out of `index.ts` so it can be imported without
 * side effects. `index.ts` ends in a module-scope `main().catch(...)` that
 * connects a `StdioServerTransport` — importing IT from a test would boot an MCP
 * server inside the test process and hold the event loop open, which is why no
 * test could reach the catalog before this file existed. Nothing here touches
 * the filesystem, the network or stdio at import time; the tool modules it pulls
 * in only define schemas and export handlers.
 *
 * `tests/unit/tool-count.test.ts` imports TOOLS from here to cross-check the
 * hand-written tool counts in the docs against the live catalog.
 */
// Not exported: it was file-local in `index.ts` at HEAD, has no importer, and an
// extraction should not widen visibility as a side effect.
type ToolHandler = (args: unknown) => Promise<unknown>

export const TOOLS: Tool[] = [
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
  requestRebaseTool,
  planAuthorizeTool,
  planRevokeTool,
  planDisposeTool,
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
  phaseReviewStartTool,
  phaseReviewCompleteTool,
  phaseTestStartTool,
  phaseTestCompleteTool,
  phaseAbandonTool,
  captureIssueTool,
  personaReviewTool,
  autoPersonaTool,
  tutorStepTool,
  auditTool,
]

export const HANDLERS: Record<string, ToolHandler> = {
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
  rsct_request_rebase: requestRebaseHandler,
  rsct_plan_authorize: planAuthorizeHandler,
  rsct_plan_revoke: planRevokeHandler,
  rsct_plan_dispose: planDisposeHandler,
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
  rsct_phase_review_start: phaseReviewStartHandler,
  rsct_phase_review_complete: phaseReviewCompleteHandler,
  rsct_phase_test_start: phaseTestStartHandler,
  rsct_phase_test_complete: phaseTestCompleteHandler,
  rsct_phase_abandon: phaseAbandonHandler,
  rsct_capture_issue: captureIssueHandler,
  rsct_persona_review: personaReviewHandler,
  rsct_auto_persona: autoPersonaHandler,
  rsct_tutor_step: tutorStepHandler,
  rsct_audit: auditHandler,
}
