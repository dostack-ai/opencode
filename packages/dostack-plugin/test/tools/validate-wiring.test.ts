import { describe, test, expect, mock } from "bun:test"
import { validateWiring } from "../../src/tools/validate-wiring"
import { mkdtemp, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

async function setupFixture() {
  const dir = await mkdtemp(join(tmpdir(), "dostack-test-"))
  await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
  await writeFile(
    join(dir, "frontend/src/domain/config.ts"),
    `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: {
      workflowId: "wf-1",
      outputMapping: {
        summary: "rfp_analyses.summary",
        key_dates: "rfp_analyses.key_dates",
        missing_field: "rfp_analyses.nonexistent_col",
      },
    },
    unknownWorkflow: {
      workflowId: "wf-999",
      outputMapping: {},
    },
  },
}`,
  )
  await mkdir(join(dir, "backend/migrations"), { recursive: true })
  await writeFile(
    join(dir, "backend/migrations/001_initial.sql"),
    `CREATE TABLE rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id UUID NOT NULL REFERENCES rfps(id),
  summary TEXT,
  key_dates JSONB,
  risk_score INTEGER
);`,
  )
  return dir
}

function makeMockClient() {
  const schemas: Record<string, any> = {
    "wf-1": { workflow_id: "wf-1", workflow_name: "RFP Analyzer", version_id: "v-1", version_number: 3, input_schema: { fields: [] } },
  }
  return {
    external: {
      get: mock(async (path: string) => {
        const match = path.match(/\/api\/v1\/workflows\/([^/]+)\/schema/)
        if (match && schemas[match[1]]) return schemas[match[1]]
        const { ApiClientError } = await import("../../src/api-client")
        throw new ApiClientError(404, "not_found")
      }),
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

describe("validateWiring", () => {
  test("detects unknown workflow ID", async () => {
    const dir = await setupFixture()
    const client = makeMockClient()
    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    expect(result.valid).toBe(false)
    const unknownErr = result.errors.find((e: any) => e.message.includes("wf-999"))
    expect(unknownErr).toBeDefined()
  })

  test("detects column that does not exist in migrations", async () => {
    const dir = await setupFixture()
    const client = makeMockClient()
    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    const colErr = result.errors.find((e: any) => e.message.includes("nonexistent_col"))
    expect(colErr).toBeDefined()
  })

  test("valid mappings produce no errors for those fields", async () => {
    const dir = await setupFixture()
    const client = makeMockClient()
    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    const summaryErr = result.errors.find((e: any) => e.message.includes('"summary"'))
    expect(summaryErr).toBeUndefined()
  })

  test("warns about unmapped workflow output fields when internal API returns step schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-test-"))
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    // Config only maps "summary" — leaves "risk_score" unmapped
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: {
      workflowId: "wf-1",
      outputMapping: {
        summary: "rfp_analyses.summary",
      },
    },
  },
}`,
    )
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_initial.sql"),
      `CREATE TABLE rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary TEXT,
  risk_score INTEGER
);`,
    )

    const client = {
      external: {
        get: mock(async () => ({
          workflow_id: "wf-1",
          workflow_name: "RFP Analyzer",
          version_id: "v-1",
          version_number: 1,
          input_schema: { fields: [] },
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
      internal: {
        get: mock(async () => ({
          steps: [
            {
              step_key: "analyze",
              step_name: "Analyze RFP",
              structured_output_schema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  risk_score: { type: "number" },
                },
              },
            },
          ],
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
    }

    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    expect(result.valid).toBe(true) // no errors, just warnings
    const unmappedWarn = result.warnings.find((w: any) => w.message.includes("risk_score") && w.message.includes("not mapped"))
    expect(unmappedWarn).toBeDefined()
    // summary IS mapped — should not appear as unmapped
    const summaryUnmapped = result.warnings.find((w: any) => w.message.includes("'summary'") && w.message.includes("not mapped"))
    expect(summaryUnmapped).toBeUndefined()
  })

  test("skips unwired-output check when internal API is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-test-"))
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: {
      workflowId: "wf-1",
      outputMapping: {
        summary: "rfp_analyses.summary",
      },
    },
  },
}`,
    )
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_initial.sql"),
      `CREATE TABLE rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary TEXT
);`,
    )

    const client = {
      external: {
        get: mock(async () => ({
          workflow_id: "wf-1",
          workflow_name: "RFP Analyzer",
          version_id: "v-1",
          version_number: 1,
          input_schema: { fields: [] },
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
      internal: {
        get: mock(async () => {
          throw new Error("internal API not configured")
        }),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
    }

    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    expect(result.valid).toBe(true)
    const internalErr = result.errors.find((e: any) => e.message.includes("internal API"))
    expect(internalErr).toBeUndefined()
    // No "not mapped" warnings because we couldn't get output schema
    const unmappedWarn = result.warnings.find((w: any) => w.message.includes("not mapped"))
    expect(unmappedWarn).toBeUndefined()
  })

  test("warns on type mismatch between workflow output type and Postgres column type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-test-"))
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    // Maps "summary" (string) → rfp_analyses.key_dates (JSONB) — mismatch
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: {
      workflowId: "wf-1",
      outputMapping: {
        summary: "rfp_analyses.key_dates",
      },
    },
  },
}`,
    )
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_initial.sql"),
      `CREATE TABLE rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_dates JSONB
);`,
    )

    const client = {
      external: {
        get: mock(async () => ({
          workflow_id: "wf-1",
          workflow_name: "RFP Analyzer",
          version_id: "v-1",
          version_number: 1,
          input_schema: { fields: [] },
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
      internal: {
        get: mock(async () => ({
          steps: [
            {
              step_key: "analyze",
              step_name: "Analyze RFP",
              structured_output_schema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                },
              },
            },
          ],
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
    }

    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    expect(result.valid).toBe(true) // type mismatches are warnings, not errors
    const mismatchWarn = result.warnings.find(
      (w: any) => w.message.includes("Type mismatch") && w.message.includes("summary") && w.message.includes("string") && w.message.includes("JSONB"),
    )
    expect(mismatchWarn).toBeDefined()
  })

  test("no type mismatch warning when types are compatible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-test-"))
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: {
      workflowId: "wf-1",
      outputMapping: {
        summary: "rfp_analyses.summary",
        items: "rfp_analyses.items",
        score: "rfp_analyses.score",
        active: "rfp_analyses.active",
      },
    },
  },
}`,
    )
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_initial.sql"),
      `CREATE TABLE rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary TEXT,
  items JSONB,
  score INTEGER,
  active BOOLEAN
);`,
    )

    const client = {
      external: {
        get: mock(async () => ({
          workflow_id: "wf-1",
          workflow_name: "RFP Analyzer",
          version_id: "v-1",
          version_number: 1,
          input_schema: { fields: [] },
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
      internal: {
        get: mock(async () => ({
          steps: [
            {
              step_key: "analyze",
              step_name: "Analyze",
              structured_output_schema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  items: { type: "array" },
                  score: { type: "number" },
                  active: { type: "boolean" },
                },
              },
            },
          ],
        })),
        post: mock(async () => ({})),
        put: mock(async () => ({})),
        delete: mock(async () => ({})),
      },
    }

    const result = JSON.parse(await validateWiring(client as any, dir, {}))
    expect(result.valid).toBe(true)
    const mismatchWarn = result.warnings.find((w: any) => w.message.includes("Type mismatch"))
    expect(mismatchWarn).toBeUndefined()
  })
})
