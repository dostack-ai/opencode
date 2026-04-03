import { describe, test, expect } from "bun:test"
import { flagWorkflowGap } from "../../src/tools/flag-workflow-gap"
import { mkdtemp, readFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("flagWorkflowGap", () => {
  test("creates status file and adds workflow entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-gap-"))
    const result = JSON.parse(
      await flagWorkflowGap(dir, {
        workflow_name: "Technical Compliance Drafter",
        description: "Drafts technical responses using company KB",
        expected_inputs: [{ name: "rfp_section", type: "text" }],
        expected_outputs: [{ name: "draft", type: "text" }],
        capability_types: ["llm_task"],
      }),
    )
    expect(result.status).toBe("added")
    expect(result.summary.needs_building).toBe(1)
    const fileContent = JSON.parse(await readFile(join(dir, ".dostack/workflow-status.json"), "utf-8"))
    expect(fileContent.workflows).toHaveLength(1)
    expect(fileContent.workflows[0].name).toBe("Technical Compliance Drafter")
    expect(fileContent.workflows[0].status).toBe("needs_building")
  })

  test("updates existing workflow entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-gap-"))
    await flagWorkflowGap(dir, {
      workflow_name: "Drafter",
      description: "v1",
      expected_inputs: [],
      expected_outputs: [],
      capability_types: ["llm_task"],
    })
    const result = JSON.parse(
      await flagWorkflowGap(dir, {
        workflow_name: "Drafter",
        description: "v2 updated",
        expected_inputs: [{ name: "input", type: "text" }],
        expected_outputs: [],
        capability_types: ["llm_task", "browser_agent"],
      }),
    )
    expect(result.status).toBe("updated")
    const fileContent = JSON.parse(await readFile(join(dir, ".dostack/workflow-status.json"), "utf-8"))
    expect(fileContent.workflows).toHaveLength(1)
    expect(fileContent.workflows[0].description).toBe("v2 updated")
    expect(fileContent.workflows[0].capability_types).toEqual(["llm_task", "browser_agent"])
  })

  test("appends multiple workflows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-gap-"))
    await flagWorkflowGap(dir, {
      workflow_name: "Workflow A",
      description: "First",
      expected_inputs: [],
      expected_outputs: [],
      capability_types: ["llm_task"],
    })
    await flagWorkflowGap(dir, {
      workflow_name: "Workflow B",
      description: "Second",
      expected_inputs: [],
      expected_outputs: [],
      capability_types: ["browser_agent"],
    })
    const fileContent = JSON.parse(await readFile(join(dir, ".dostack/workflow-status.json"), "utf-8"))
    expect(fileContent.workflows).toHaveLength(2)
  })
})
