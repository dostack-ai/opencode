import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseDostackConfig } from "./config"
import { createApiClient } from "./api-client"
import { loadBuildRequest, type BuildRequest } from "./build-request"
import { createEventEmitter, type EventEmitter } from "./event-emitter"
import { createQueryWorkflowsTool } from "./tools/query-workflows"
import { createGetWorkflowSchemaTool } from "./tools/get-workflow-schema"
import { createCreateWorkflowVersionTool } from "./tools/create-workflow-version"
import { createValidateWiringTool } from "./tools/validate-wiring"
import { createFlagWorkflowGapTool } from "./tools/flag-workflow-gap"
import { createTriggerPreviewTool } from "./tools/trigger-preview"
import { createGetRuntimeErrorsTool } from "./tools/get-runtime-errors"
import { createBeforePromptHook } from "./hooks/before-prompt"
import { createAfterResponseHook, createTextCompleteHook } from "./hooks/after-response"

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

  // Phase 1c: build events go to the coordinator's /builds/{id}/events route.
  // Config may pass coordinator_api_url explicitly; fall back to api_url so
  // deployments that haven't split the coordinator API yet still work.
  const buildJobId = config.build_job_id ?? buildRequest?.build_job_id
  let eventEmitter: EventEmitter | undefined
  if (buildJobId && config.builder_auth_token) {
    const coordinatorBase = config.coordinator_api_url ?? config.api_url
    eventEmitter = createEventEmitter({
      coordinatorBase,
      buildJobId,
      authToken: config.builder_auth_token,
    })
    console.log(
      `[dostack-plugin] event emitter armed for build_job_id=${buildJobId} via ${coordinatorBase}`,
    )
  } else {
    console.warn(
      "[dostack-plugin] builder_auth_token / build_job_id missing — events will not be emitted",
    )
  }

  const beforePrompt = createBeforePromptHook(projectDir, client, { config, buildRequest })

  // Combine invalidate with an event-emitter-driven reset for parity with the
  // legacy resetStatus() hook. When the user re-asks the model to work, we
  // re-arm verification state.
  const invalidateAndReset = () => {
    beforePrompt.invalidate()
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
    "tool.execute.after": createAfterResponseHook(projectDir, invalidateAndReset, undefined, eventEmitter),
    "experimental.text.complete": createTextCompleteHook(beforePrompt.setVerificationPending, {
      isVerificationComplete: beforePrompt.isVerificationComplete,
      // Task 12 installs the real onBuildComplete (package assemble + POST /complete).
      // For Task 11, only emit a completion-intent event so downstream can observe it.
      onBuildComplete: eventEmitter
        ? async () => {
            await eventEmitter!.emit("builder.step.completed", { step: "generating" })
          }
        : undefined,
    }),
  }
}

export default {
  id: "dostack",
  server: dostackPlugin,
} satisfies PluginModule
