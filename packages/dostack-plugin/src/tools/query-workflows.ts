import { tool } from "@opencode-ai/plugin/tool"
import type { ApiClient } from "../api-client"

type WorkflowSummary = {
  id: string
  name: string
  description: string
  currentVersionId: string
  versionNumber: number
  hasFileInputs: boolean
  capabilityTypes: string[]
}

export async function queryWorkflows(
  client: ApiClient,
  filters: { capability_type?: string; search?: string },
): Promise<string> {
  const data = (await client.external.get("/api/v1/workflows")) as {
    workflows: Array<{
      workflow_id: string
      workflow_name: string
      description: string
      current_version_id: string
      version_number: number
      has_file_inputs: boolean
      capabilities?: string[]
    }>
  }

  let workflows = data.workflows

  if (filters.capability_type) {
    const cap = filters.capability_type.toLowerCase()
    workflows = workflows.filter((w) => w.capabilities?.some((c) => c.toLowerCase() === cap))
  }

  if (filters.search) {
    const q = filters.search.toLowerCase()
    workflows = workflows.filter(
      (w) => w.workflow_name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
    )
  }

  const summaries: WorkflowSummary[] = workflows.map((w) => ({
    id: w.workflow_id,
    name: w.workflow_name,
    description: w.description,
    currentVersionId: w.current_version_id,
    versionNumber: w.version_number,
    hasFileInputs: w.has_file_inputs,
    capabilityTypes: w.capabilities ?? [],
  }))

  return JSON.stringify(summaries, null, 2)
}

export function createQueryWorkflowsTool(client: ApiClient) {
  return tool({
    description:
      "Query the user's workflow registry. Returns workflow names, descriptions, IDs, input schemas, and capability types. Use this to discover what workflows are available for wiring into the workbench.",
    args: {
      capability_type: tool.schema
        .string()
        .optional()
        .describe('Filter by capability type (e.g. "llm_task", "browser_agent", "document_ingestion")'),
      search: tool.schema.string().optional().describe("Free-text search across workflow names and descriptions"),
    },
    async execute(args) {
      return queryWorkflows(client, args)
    },
  })
}
