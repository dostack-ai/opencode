import { describe, test, expect, mock } from "bun:test"
import { getWorkflowSchema } from "../../src/tools/get-workflow-schema"

function makeMockClient(opts?: { internalConfigured?: boolean }) {
  const externalSchema = {
    workflow_id: "wf-1",
    workflow_name: "RFP Analyzer",
    version_id: "v-1",
    version_number: 3,
    input_schema: {
      fields: [
        { name: "company_name", type: "text", label: "Company Name", required: true },
        { name: "document", type: "file", label: "RFP Document", required: true },
      ],
    },
  }

  const internalVersion = {
    version_id: "v-1",
    steps: [
      {
        step_key: "step_1",
        step_name: "Analyze Document",
        structured_output_schema: {
          type: "object",
          properties: { summary: { type: "string" }, key_dates: { type: "array" } },
        },
      },
      {
        step_key: "step_2",
        step_name: "Extract Requirements",
        structured_output_schema: {
          type: "object",
          properties: { requirements: { type: "array" } },
        },
      },
    ],
  }

  return {
    external: {
      get: mock(async () => externalSchema),
      post: mock(async () => ({})),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
    internal: {
      get: opts?.internalConfigured !== false
        ? mock(async () => internalVersion)
        : mock(async () => { throw new Error("internal API is not configured") }),
      post: mock(async () => ({})),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
  }
}

describe("getWorkflowSchema", () => {
  test("returns combined input and output schemas", async () => {
    const client = makeMockClient()
    const result = JSON.parse(await getWorkflowSchema(client as any, { workflow_id: "wf-1" }))

    expect(result.workflowId).toBe("wf-1")
    expect(result.workflowName).toBe("RFP Analyzer")
    expect(result.inputSchema.fields).toHaveLength(2)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].stepKey).toBe("step_1")
    expect(result.steps[0].name).toBe("Analyze Document")
    expect(result.steps[0].structuredOutputSchema.properties).toHaveProperty("summary")
  })

  test("returns input schema only when internal API unavailable", async () => {
    const client = makeMockClient({ internalConfigured: false })
    const result = JSON.parse(await getWorkflowSchema(client as any, { workflow_id: "wf-1" }))

    expect(result.inputSchema.fields).toHaveLength(2)
    expect(result.steps).toBeUndefined()
    expect(result.note).toContain("internal API")
  })

  test("passes version_id to internal API when provided", async () => {
    const client = makeMockClient()
    await getWorkflowSchema(client as any, { workflow_id: "wf-1", version_id: "v-custom" })

    expect(client.internal.get).toHaveBeenCalledWith("/workflow/wf-1/versions/v-custom")
  })
})
