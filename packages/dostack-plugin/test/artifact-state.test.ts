import { describe, test, expect } from "bun:test"
import { scanArtifactState } from "../src/artifact-state"
import { mkdtemp, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

async function setupFixture() {
  const dir = await mkdtemp(join(tmpdir(), "dostack-artifact-"))

  await mkdir(join(dir, "backend/migrations"), { recursive: true })
  await writeFile(
    join(dir, "backend/migrations/001_initial.sql"),
    `CREATE TABLE rfps (id UUID PRIMARY KEY, title TEXT, status TEXT);
CREATE TABLE rfp_analyses (id UUID PRIMARY KEY, rfp_id UUID, summary TEXT, key_dates JSONB);`,
  )
  await writeFile(
    join(dir, "backend/migrations/002_reviews.sql"),
    `CREATE TABLE rfp_reviews (id UUID PRIMARY KEY, rfp_id UUID, reviewer TEXT, comments TEXT);`,
  )

  await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
  await writeFile(
    join(dir, "frontend/src/domain/config.ts"),
    `export const workflowConfig = {
  workflows: {
    rfpAnalyzer: { workflowId: "wf-1", outputMapping: { summary: "rfp_analyses.summary" } },
  },
  phases: ["intake", "analysis", "review"],
}`,
  )

  await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
  await writeFile(join(dir, "frontend/src/domain/pages/Dashboard.tsx"), "export default function Dashboard() {}")
  await writeFile(join(dir, "frontend/src/domain/pages/Analysis.tsx"), "export default function Analysis() {}")

  await mkdir(join(dir, ".dostack"), { recursive: true })
  await writeFile(
    join(dir, ".dostack/workflow-status.json"),
    JSON.stringify({
      workflows: [
        { name: "Technical Drafter", status: "needs_building", capability_types: ["llm_task"] },
      ],
    }),
  )

  return dir
}

describe("scanArtifactState", () => {
  test("scans migrations and extracts table names", async () => {
    const dir = await setupFixture()
    const state = await scanArtifactState(dir)
    expect(state.migrations).toHaveLength(2)
    expect(state.migrations[0].file).toBe("001_initial.sql")
    expect(state.migrations[0].tables).toContain("rfps")
    expect(state.migrations[0].tables).toContain("rfp_analyses")
    expect(state.migrations[1].tables).toContain("rfp_reviews")
  })

  test("scans config and extracts workflow wiring", async () => {
    const dir = await setupFixture()
    const state = await scanArtifactState(dir)
    expect(state.config.workflows).toHaveLength(1)
    expect(state.config.workflows[0].name).toBe("rfpAnalyzer")
    expect(state.config.workflows[0].workflowId).toBe("wf-1")
    expect(state.config.phases).toEqual(["intake", "analysis", "review"])
  })

  test("scans pages directory", async () => {
    const dir = await setupFixture()
    const state = await scanArtifactState(dir)
    expect(state.pages).toContain("Dashboard.tsx")
    expect(state.pages).toContain("Analysis.tsx")
  })

  test("reads workflow gaps", async () => {
    const dir = await setupFixture()
    const state = await scanArtifactState(dir)
    expect(state.gaps).toHaveLength(1)
    expect(state.gaps[0].name).toBe("Technical Drafter")
  })

  test("handles missing directories gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-empty-"))
    const state = await scanArtifactState(dir)
    expect(state.migrations).toEqual([])
    expect(state.pages).toEqual([])
    expect(state.gaps).toEqual([])
  })
})
