import { describe, test, expect, mock } from "bun:test"
import { queryWorkflows } from "../../src/tools/query-workflows"

const mockWorkflows = [
  {
    workflow_id: "wf-1",
    workflow_name: "RFP Analyzer",
    description: "Analyzes RFP documents",
    current_version_id: "v-1",
    version_number: 3,
    has_file_inputs: true,
    total_executions: 42,
    capabilities: ["llm_task", "document_ingestion"],
  },
  {
    workflow_id: "wf-2",
    workflow_name: "Risk Analyzer",
    description: "Identifies financial and legal risks",
    current_version_id: "v-2",
    version_number: 2,
    has_file_inputs: false,
    total_executions: 15,
    capabilities: ["llm_task"],
  },
  {
    workflow_id: "wf-3",
    workflow_name: "Web Scraper",
    description: "Scrapes competitor websites",
    current_version_id: "v-3",
    version_number: 1,
    has_file_inputs: false,
    total_executions: 5,
    capabilities: ["browser_agent"],
  },
]

function makeMockClient() {
  return {
    external: {
      get: mock(async () => ({ workflows: mockWorkflows })),
      post: mock(async () => ({})),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
    internal: {
      get: mock(async () => ({})),
      post: mock(async () => ({})),
      put: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
  }
}

describe("queryWorkflows", () => {
  test("returns all workflows when no filters", async () => {
    const client = makeMockClient()
    const result = await queryWorkflows(client as any, {})
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(3)
    expect(parsed[0].id).toBe("wf-1")
    expect(parsed[0].name).toBe("RFP Analyzer")
  })

  test("filters by capability_type", async () => {
    const client = makeMockClient()
    const result = await queryWorkflows(client as any, { capability_type: "browser_agent" })
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe("Web Scraper")
  })

  test("filters by search query (case-insensitive)", async () => {
    const client = makeMockClient()
    const result = await queryWorkflows(client as any, { search: "risk" })
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe("Risk Analyzer")
  })

  test("combines filters", async () => {
    const client = makeMockClient()
    const result = await queryWorkflows(client as any, { capability_type: "llm_task", search: "rfp" })
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe("RFP Analyzer")
  })
})
