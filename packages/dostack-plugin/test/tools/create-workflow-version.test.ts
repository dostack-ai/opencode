import { describe, test, expect, mock } from "bun:test"
import { createWorkflowVersion } from "../../src/tools/create-workflow-version"

const mockVersionData = {
  version_id: "v-1",
  definition: {
    States: {
      step_1_analyze: {
        Type: "Task",
        Next: "step_2_summarize",
      },
      step_2_summarize: {
        Type: "Task",
        InputPath: "$.step_1_analyze",
        Next: "step_3_review",
      },
      step_3_review: {
        Type: "Task",
        InputPath: "$.step_2_summarize",
        End: true,
      },
    },
  },
  steps: [
    { step_key: "step_1", step_name: "Analyze", structured_output_schema: {} },
    { step_key: "step_2", step_name: "Summarize", structured_output_schema: {} },
    { step_key: "step_3", step_name: "Review", structured_output_schema: {} },
  ],
}

function makeMockClient(opts?: { createResponse?: unknown }) {
  return {
    external: {
      get: mock(async () => ({})),
      post: mock(async () => ({})),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
    internal: {
      get: mock(async () => mockVersionData),
      post: mock(async () => opts?.createResponse ?? { version_id: "v-2" }),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
  }
}

describe("createWorkflowVersion", () => {
  test("creates version and returns new version_id", async () => {
    const client = makeMockClient()
    const result = JSON.parse(
      await createWorkflowVersion(client as any, {
        workflow_id: "wf-1",
        step_modifications: [{ step_key: "step_3", structured_output_schema: { type: "object" } }],
      }),
    )
    expect(result.versionId).toBe("v-2")
    expect(result.warnings).toEqual([])
  })

  test("warns when modifying a step that has downstream dependencies", async () => {
    const client = makeMockClient()
    const result = JSON.parse(
      await createWorkflowVersion(client as any, {
        workflow_id: "wf-1",
        step_modifications: [{ step_key: "step_1", structured_output_schema: { type: "object" } }],
      }),
    )
    expect(result.versionId).toBe("v-2")
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("step_2")
  })

  test("errors when internal API not configured", async () => {
    const client = {
      external: { get: mock(async () => ({})), post: mock(async () => ({})), put: mock(async () => ({})), delete: mock(async () => ({})) },
      internal: {
        get: mock(async () => { throw new Error("internal API is not configured") }),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
    }
    const result = JSON.parse(
      await createWorkflowVersion(client as any, {
        workflow_id: "wf-1",
        step_modifications: [{ step_key: "step_1", structured_output_schema: {} }],
      }),
    )
    expect(result.error).toContain("internal API")
  })
})
