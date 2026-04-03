import { tool } from "@opencode-ai/plugin/tool"
import type { ApiClient } from "../api-client"

type StepModification = {
  step_key: string
  structured_output_schema: unknown
}

function analyzeDownstreamDependencies(
  definition: { States: Record<string, any> },
  steps: Array<{ step_key: string; step_name: string }>,
  modifiedStepKeys: string[],
): string[] {
  const warnings: string[] = []
  const states = definition.States

  for (const modifiedKey of modifiedStepKeys) {
    for (const [stateName, state] of Object.entries(states)) {
      if (typeof state !== "object" || !state) continue
      const stateStr = JSON.stringify(state)
      if (stateStr.includes(`$.${modifiedKey}`) && !stateName.includes(modifiedKey)) {
        const depStep = steps.find(
          (s) => stateName.includes(s.step_key) || stateName.includes(s.step_name.toLowerCase().replace(/\s+/g, "_")),
        )
        const depLabel = depStep ? `${depStep.step_name} (${depStep.step_key})` : stateName
        warnings.push(
          `Modifying ${modifiedKey} may affect downstream state "${depLabel}" which references its output.`,
        )
      }
    }
  }

  return [...new Set(warnings)]
}

export async function createWorkflowVersion(
  client: ApiClient,
  args: {
    workflow_id: string
    step_modifications: StepModification[]
    description?: string
  },
): Promise<string> {
  let versionData: {
    version_id: string
    definition: { States: Record<string, any> }
    steps: Array<{ step_key: string; step_name: string; structured_output_schema: unknown }>
  }

  try {
    versionData = (await client.internal.get(`/workflow/${args.workflow_id}/versions/current`)) as any
  } catch (err) {
    return JSON.stringify({
      error: `Cannot create workflow version: ${(err as Error).message}. Ensure internal_api_url and internal_api_token are configured.`,
    })
  }

  const modifiedKeys = args.step_modifications.map((m) => m.step_key)
  const warnings = analyzeDownstreamDependencies(versionData.definition, versionData.steps, modifiedKeys)

  const createResult = (await client.internal.post(`/workflow/${args.workflow_id}/versions/create`, {
    base_version_id: versionData.version_id,
    step_modifications: args.step_modifications,
    description: args.description,
  })) as { version_id: string }

  return JSON.stringify({
    versionId: createResult.version_id,
    baseVersionId: versionData.version_id,
    modifiedSteps: modifiedKeys,
    warnings,
  }, null, 2)
}

export function createCreateWorkflowVersionTool(client: ApiClient) {
  return tool({
    description:
      "Create a new version of a workflow with modified structured_output_schema on specific steps. Runs dependency analysis first to warn about downstream impacts. Requires internal API access.",
    args: {
      workflow_id: tool.schema.string().describe("The workflow ID to create a new version for"),
      step_modifications: tool.schema
        .array(
          tool.schema.object({
            step_key: tool.schema.string().describe("The step key to modify"),
            structured_output_schema: tool.schema.record(tool.schema.string(), tool.schema.unknown()).describe("New structured output schema for this step"),
          }),
        )
        .describe("Array of step modifications with new output schemas"),
      description: tool.schema.string().optional().describe("Description for the new version"),
    },
    async execute(args) {
      return createWorkflowVersion(client, args)
    },
  })
}
