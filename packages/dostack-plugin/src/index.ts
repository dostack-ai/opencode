import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseDostackConfig } from "./config"
import { createApiClient } from "./api-client"
import { loadBuildRequest, type BuildRequest } from "./build-request"
import { createEventEmitter, type EventEmitter } from "./event-emitter"
import { assembleAndUploadPackage, postComplete } from "./package-assembler"
import { createQueryWorkflowsTool } from "./tools/query-workflows"
import { createGetWorkflowSchemaTool } from "./tools/get-workflow-schema"
import { createCreateWorkflowVersionTool } from "./tools/create-workflow-version"
import { createValidateWiringTool } from "./tools/validate-wiring"
import { createFlagWorkflowGapTool } from "./tools/flag-workflow-gap"
import { createTriggerPreviewTool } from "./tools/trigger-preview"
import { createGetRuntimeErrorsTool } from "./tools/get-runtime-errors"
import { createBuildCompleteTool } from "./tools/build-complete"
import { createBeforePromptHook } from "./hooks/before-prompt"
import { createAfterResponseHook, createTextCompleteHook } from "./hooks/after-response"
import { join } from "node:path"

// The app-template Vite build outputs to frontend/dist. This is the path
// inside the Fargate task workspace that the plugin inspects when packaging.
// If the template ever moves this path, we must update this constant in
// lockstep — the coordinator's /complete handler does NOT infer it.
const FRONTEND_BUNDLE_REL = "frontend/dist"

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
  const coordinatorBase = config.coordinator_api_url || config.api_url
  const authToken = config.builder_auth_token
  let eventEmitter: EventEmitter | undefined
  if (buildJobId && authToken && coordinatorBase) {
    eventEmitter = createEventEmitter({
      coordinatorBase,
      buildJobId,
      authToken,
    })
    console.log(
      `[dostack-plugin] event emitter armed for build_job_id=${buildJobId} via ${coordinatorBase}`,
    )
  } else {
    console.warn(
      "[dostack-plugin] builder_auth_token / build_job_id / coordinator_api_url missing — events will not be emitted",
    )
  }

  const beforePrompt = createBeforePromptHook(projectDir, client, { config, buildRequest })

  const invalidateAndReset = () => {
    beforePrompt.invalidate()
  }

  // Phase 1c onBuildComplete: assemble the package, upload to S3, and POST
  // /complete so the coordinator flips the workbench to "ready". Any error
  // in this flow emits builder.log.error and does NOT call /complete — the
  // coordinator's watchdog will time out and fail the job cleanly.
  //
  // Phase 1c Task 0A v2: completion can be triggered by either the
  // experimental.text.complete hook (regex / silence timeout) OR by the
  // LLM calling dostack_build_complete explicitly. The idempotency flag
  // below is shared between both paths so whichever fires first wins;
  // subsequent fires are no-ops. See docs/superpowers/plans/
  // 2026-04-14-opencode-runtime-errors-tool.md and
  // packages/dostack-plugin/src/tools/build-complete.ts for context.
  const packageS3Bucket = config.package_s3_bucket ?? process.env.PACKAGE_S3_BUCKET
  let completionInvoked = false
  const isCompletionInvoked = () => completionInvoked
  const setCompletionInvoked = (v: boolean) => {
    completionInvoked = v
  }

  // buildCompleteInternal: the raw package-upload + /complete flow, with
  // no idempotency guard. Callers are responsible for ensuring this runs
  // at most once per session. Exposed to the dostack_build_complete tool
  // so it can set the flag itself before invoking.
  const buildCompleteInternal = async () => {
    if (!eventEmitter || !buildJobId || !authToken || !coordinatorBase) {
      console.warn(
        "[dostack-plugin] onBuildComplete skipped: event emitter / job id / auth token / coordinator base missing",
      )
      return
    }
    if (!packageS3Bucket) {
      await eventEmitter.emit("builder.log.error", {
        code: "missing_package_s3_bucket",
        message: "package_s3_bucket not configured on plugin",
      })
      return
    }
    if (!buildRequest) {
      await eventEmitter.emit("builder.log.error", {
        code: "missing_build_request",
        message: "cannot assemble package without loaded build request",
      })
      return
    }
    try {
      const bundleDir = join(projectDir, FRONTEND_BUNDLE_REL)
      const assembled = await assembleAndUploadPackage({
        workbenchId: buildRequest.workbench_id,
        specVersion: buildRequest.spec.spec_version,
        bundleDir,
        packageS3Bucket,
        spec: buildRequest.spec as unknown as Record<string, unknown>,
        // Phase 1e Option B: package-assembler uploads via coordinator
        // presigned URLs (no AWS SDK in the plugin upload path).
        coordinatorBase,
        buildJobId,
        authToken,
      })
      await eventEmitter.emit("builder.package.uploaded", {
        package_version: assembled.packageVersion,
        file_count: assembled.fileCount,
      })
      await postComplete(coordinatorBase, buildJobId, authToken, assembled.s3Prefix)
      await eventEmitter.emit("builder.build.completed", {
        package_version: assembled.packageVersion,
      })
    } catch (err) {
      console.error("[dostack-plugin] onBuildComplete failed:", err)
      await eventEmitter.emit("builder.log.error", {
        code: "complete_flow_failed",
        message: String((err as Error)?.message ?? err),
      })
    }
  }

  // buildComplete: guarded wrapper used by the textComplete hook path.
  // Short-circuits if completion was already dispatched by the tool call.
  const buildComplete = async () => {
    if (completionInvoked) {
      console.info(
        "[dostack-plugin] textComplete-triggered buildComplete short-circuited " +
          "— dostack_build_complete tool already fired.",
      )
      return
    }
    completionInvoked = true
    await buildCompleteInternal()
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
      dostack_build_complete: createBuildCompleteTool({
        projectDir,
        isCompletionInvoked,
        setCompletionInvoked,
        runBuildComplete: buildCompleteInternal,
      }),
    },
    "experimental.chat.system.transform": beforePrompt.hook,
    "tool.execute.after": createAfterResponseHook(projectDir, invalidateAndReset, undefined, eventEmitter),
    "experimental.text.complete": createTextCompleteHook(beforePrompt.setVerificationPending, {
      isVerificationComplete: beforePrompt.isVerificationComplete,
      onBuildComplete: eventEmitter ? buildComplete : undefined,
    }),
  }
}

export default {
  id: "dostack",
  server: dostackPlugin,
} satisfies PluginModule
