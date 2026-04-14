import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseDostackConfig } from "./config"
import { createApiClient } from "./api-client"
import { createQueryWorkflowsTool } from "./tools/query-workflows"
import { createGetWorkflowSchemaTool } from "./tools/get-workflow-schema"
import { createCreateWorkflowVersionTool } from "./tools/create-workflow-version"
import { createValidateWiringTool } from "./tools/validate-wiring"
import { createFlagWorkflowGapTool } from "./tools/flag-workflow-gap"
import { createTriggerPreviewTool } from "./tools/trigger-preview"
import { createGetRuntimeErrorsTool } from "./tools/get-runtime-errors"
import { createBeforePromptHook } from "./hooks/before-prompt"
import { createAfterResponseHook } from "./hooks/after-response"

const dostackPlugin: Plugin = async (input, options) => {
  const config = parseDostackConfig(options ?? {})
  const client = createApiClient(config)
  const projectDir = input.directory

  const beforePrompt = createBeforePromptHook(projectDir, client)

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
    "tool.execute.after": createAfterResponseHook(projectDir, beforePrompt.invalidate),
  }
}

export default {
  id: "dostack",
  server: dostackPlugin,
} satisfies PluginModule
