import { tool } from "@opencode-ai/plugin/tool"
import type { ApiClient } from "../api-client"

export async function getWorkflowSchema(
  client: ApiClient,
  args: { workflow_id: string; version_id?: string },
): Promise<string> {
  const externalData = (await client.external.get(`/api/v1/workflows/${args.workflow_id}/schema`)) as {
    workflow_id: string
    workflow_name: string
    version_id: string
    version_number: number
    input_schema: unknown
  }

  const versionId = args.version_id ?? externalData.version_id

  let steps: Array<{ stepKey: string; name: string; structuredOutputSchema: unknown }> | undefined
  let note: string | undefined

  try {
    const versionData = (await client.internal.get(`/workflow/${args.workflow_id}/versions/${versionId}`)) as {
      steps: Array<{
        step_key: string
        step_name: string
        structured_output_schema: unknown
      }>
    }
    steps = versionData.steps.map((s) => ({
      stepKey: s.step_key,
      name: s.step_name,
      structuredOutputSchema: s.structured_output_schema,
    }))
  } catch {
    note = "Step output schemas unavailable — internal API is not configured. Only input schema returned."
  }

  const result: Record<string, unknown> = {
    workflowId: externalData.workflow_id,
    workflowName: externalData.workflow_name,
    versionId,
    versionNumber: externalData.version_number,
    inputSchema: externalData.input_schema,
  }
  if (steps) result.steps = steps
  if (note) result.note = note

  return JSON.stringify(result, null, 2)
}

export function createGetWorkflowSchemaTool(client: ApiClient) {
  return tool({
    description:
      "Get the full input/output schema for a specific workflow version. Returns input fields and per-step structured output schemas. Use this before wiring a workflow to understand what data it produces.",
    args: {
      workflow_id: tool.schema.string().describe("The workflow ID to get the schema for"),
      version_id: tool.schema.string().optional().describe("Specific version ID. Defaults to current version."),
    },
    async execute(args) {
      return getWorkflowSchema(client, args)
    },
  })
}
