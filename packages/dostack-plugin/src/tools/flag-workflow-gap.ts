import { tool } from "@opencode-ai/plugin/tool"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join } from "path"

type WorkflowGap = {
  name: string
  description: string
  status: "needs_building"
  expected_inputs: Array<{ name: string; type: string }>
  expected_outputs: Array<{ name: string; type: string }>
  capability_types: string[]
  flagged_at: string
}

type StatusFile = {
  workflows: WorkflowGap[]
}

async function readStatusFile(projectDir: string): Promise<StatusFile> {
  try {
    const content = await readFile(join(projectDir, ".dostack/workflow-status.json"), "utf-8")
    return JSON.parse(content)
  } catch {
    return { workflows: [] }
  }
}

async function writeStatusFile(projectDir: string, data: StatusFile): Promise<void> {
  const dir = join(projectDir, ".dostack")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "workflow-status.json"), JSON.stringify(data, null, 2))
}

export async function flagWorkflowGap(
  projectDir: string,
  args: {
    workflow_name: string
    description: string
    expected_inputs: Array<{ name: string; type: string }>
    expected_outputs: Array<{ name: string; type: string }>
    capability_types: string[]
  },
): Promise<string> {
  const statusFile = await readStatusFile(projectDir)

  const entry: WorkflowGap = {
    name: args.workflow_name,
    description: args.description,
    status: "needs_building",
    expected_inputs: args.expected_inputs,
    expected_outputs: args.expected_outputs,
    capability_types: args.capability_types,
    flagged_at: new Date().toISOString(),
  }

  const existingIdx = statusFile.workflows.findIndex((w) => w.name === args.workflow_name)
  let action: "added" | "updated"

  if (existingIdx >= 0) {
    statusFile.workflows[existingIdx] = entry
    action = "updated"
  } else {
    statusFile.workflows.push(entry)
    action = "added"
  }

  await writeStatusFile(projectDir, statusFile)

  const needsBuilding = statusFile.workflows.filter((w) => w.status === "needs_building").length

  return JSON.stringify({
    status: action,
    workflow: args.workflow_name,
    summary: {
      total: statusFile.workflows.length,
      needs_building: needsBuilding,
    },
  })
}

export function createFlagWorkflowGapTool(projectDir: string) {
  return tool({
    description:
      'Mark a workflow as "needs building" in the project\'s workflow status tracker. Use this when the workbench needs a workflow that doesn\'t exist yet.',
    args: {
      workflow_name: tool.schema.string().describe("Name of the workflow that needs to be built"),
      description: tool.schema.string().describe("What the workflow should do"),
      expected_inputs: tool.schema
        .array(tool.schema.object({ name: tool.schema.string(), type: tool.schema.string() }))
        .describe("Expected input fields for the workflow"),
      expected_outputs: tool.schema
        .array(tool.schema.object({ name: tool.schema.string(), type: tool.schema.string() }))
        .describe("Expected output fields from the workflow"),
      capability_types: tool.schema
        .array(tool.schema.string())
        .describe('Required capability types (e.g. ["llm_task", "browser_agent"])'),
    },
    async execute(args) {
      return flagWorkflowGap(projectDir, args)
    },
  })
}
