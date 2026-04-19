import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseDostackConfig } from "./config"
import { createApiClient } from "./api-client"
import { loadBuildRequest, type BuildRequest } from "./build-request"
import { createQueryWorkflowsTool } from "./tools/query-workflows"
import { createGetWorkflowSchemaTool } from "./tools/get-workflow-schema"
import { createCreateWorkflowVersionTool } from "./tools/create-workflow-version"
import { createValidateWiringTool } from "./tools/validate-wiring"
import { createFlagWorkflowGapTool } from "./tools/flag-workflow-gap"
import { createTriggerPreviewTool } from "./tools/trigger-preview"
import { createGetRuntimeErrorsTool } from "./tools/get-runtime-errors"
import { createBeforePromptHook } from "./hooks/before-prompt"
import { createAfterResponseHook, createTextCompleteHook } from "./hooks/after-response"
import { createBuildStatusReporter } from "./build-status"

const dostackPlugin: Plugin = async (input, options) => {
  const config = parseDostackConfig(options ?? {})
  const client = createApiClient(config)
  const projectDir = input.directory

  // Phase 1c: coordinator uploads a structured build request JSON to S3
  // before starting the Fargate task. Load it once at plugin init so the
  // before-prompt hook can inject the spec + workflow_bindings directly
  // instead of relying on ad-hoc chat history inference.
  //
  // Silent fallback when BUILD_REQUEST_S3_URI is absent preserves backward
  // compat with the pre-Phase-1c entrypoint path.
  let buildRequest: BuildRequest | null = null
  const buildRequestUri = process.env.BUILD_REQUEST_S3_URI
  if (buildRequestUri) {
    try {
      buildRequest = await loadBuildRequest(buildRequestUri)
      console.log(
        `[dostack-plugin] loaded build request job=${buildRequest.build_job_id} ` +
          `workbench=${buildRequest.workbench_id} bindings=${buildRequest.workflow_bindings.length}`,
      )
    } catch (err) {
      console.error("[dostack-plugin] failed to load BUILD_REQUEST_S3_URI:", err)
    }
  } else {
    console.warn(
      "[dostack-plugin] BUILD_REQUEST_S3_URI not set — running in legacy (pre-Phase-1c) mode",
    )
  }

  const beforePrompt = createBeforePromptHook(projectDir, client, { config, buildRequest })
  const buildStatus = createBuildStatusReporter(client, config)

  // Combine invalidate with status reset so re-arming also resets build status
  const invalidateAndReset = () => {
    beforePrompt.invalidate()
    buildStatus.resetStatus()
  }

  return {
    tool: {
      dostack_query_workflows: createQueryWorkflowsTool(client),
      dostack_get_workflow_schema: createGetWorkflowSchemaTool(client),
      dostack_create_workflow_version: createCreateWorkflowVersionTool(client),
      dostack_validate_wiring: createValidateWiringTool(client, projectDir),
      dostack_flag_workflow_gap: createFlagWorkflowGapTool(projectDir),
      dostack_trigger_preview: createTriggerPreviewTool(projectDir),
      dostack_get_runtime_errors: createGetRuntimeErrorsTool(config),
    },
    "experimental.chat.system.transform": beforePrompt.hook,
    "tool.execute.after": createAfterResponseHook(projectDir, invalidateAndReset, buildStatus.reportBuilding),
    "experimental.text.complete": createTextCompleteHook(beforePrompt.setVerificationPending, {
      isVerificationComplete: beforePrompt.isVerificationComplete,
      reportComplete: buildStatus.reportComplete,
    }),
  }
}

export default {
  id: "dostack",
  server: dostackPlugin,
} satisfies PluginModule
