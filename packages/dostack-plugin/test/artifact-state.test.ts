import { describe, test, expect } from "bun:test"
import { scanArtifactState, formatArtifactState } from "../src/artifact-state"
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

describe("issue detection", () => {
  test("flags demo migration when domain migrations exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_demo_items.sql"),
      "CREATE TABLE demo_items (id UUID PRIMARY KEY, name TEXT);",
    )
    await writeFile(
      join(dir, "backend/migrations/002_rfps.sql"),
      "CREATE TABLE rfps (id UUID PRIMARY KEY, title TEXT);",
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.type === "error" && i.message.includes("001_demo_items.sql"))).toBe(true)
  })

  test("does not flag demo migration when it is the only migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_demo_items.sql"),
      "CREATE TABLE demo_items (id UUID PRIMARY KEY, name TEXT);",
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.message.includes("001_demo_items.sql"))).toBe(false)
  })

  test("flags unregistered entities missing from ALLOWED_ENTITY_TYPES", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_rfps.sql"),
      "CREATE TABLE rfps (id UUID PRIMARY KEY, title TEXT);",
    )
    await writeFile(
      join(dir, "workbench-template.yaml"),
      'ALLOWED_ENTITY_TYPES: "proposals"',
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.type === "error" && i.message.includes("rfps"))).toBe(true)
  })

  test("does not flag base tables as unregistered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/000_base.sql"),
      "CREATE TABLE users (id UUID PRIMARY KEY, name TEXT);\nCREATE TABLE notifications (id UUID PRIMARY KEY, msg TEXT);",
    )
    await writeFile(
      join(dir, "workbench-template.yaml"),
      'ALLOWED_ENTITY_TYPES: "other"',
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.message.includes("users"))).toBe(false)
    expect(state.issues.some((i) => i.message.includes("notifications"))).toBe(false)
  })

  test("flags icons referenced in config but missing from ICON_MAP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const config = {
  entities: [
    { icon: "FileText", label: "Docs" },
    { icon: "BarChart", label: "Stats" },
  ],
}`,
    )
    await mkdir(join(dir, "frontend/src/components/layout"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/components/layout/Sidebar.tsx"),
      `const ICON_MAP = {
  FileText: FileTextIcon,
  Home: HomeIcon,
}`,
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.type === "error" && i.message.includes("BarChart"))).toBe(true)
    expect(state.issues.some((i) => i.message.includes("FileText"))).toBe(false)
  })

  test("flags file-type columns using text inputs instead of FileUpload (warning)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_docs.sql"),
      "CREATE TABLE documents (id UUID PRIMARY KEY, document_url TEXT, title TEXT);",
    )
    await mkdir(join(dir, "frontend/src/domain/components"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/components/DocForm.tsx"),
      `export function DocForm() { return <TextInput name="document_url" /> }`,
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.type === "warning" && i.message.includes("document_url"))).toBe(true)
  })

  test("does not flag file-type columns when FileUpload is used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_docs.sql"),
      "CREATE TABLE documents (id UUID PRIMARY KEY, document_url TEXT, title TEXT);",
    )
    await mkdir(join(dir, "frontend/src/domain/components"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/components/DocForm.tsx"),
      `import { FileUpload } from "@/components/FileUpload"
export function DocForm() { return <FileUpload name="document_url" /> }`,
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.message.includes("document_url"))).toBe(false)
  })

  test("flags empty workflowId in config.ts wiring", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const config = {
  workflows: {
    rfpAnalysis: { workflowId: "", outputMapping: { summary: "rfps.summary" } },
  },
  phases: ["intake", "analysis"],
}`,
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.type === "error" && i.message.includes("rfpAnalysis"))).toBe(true)
    expect(state.issues.some((i) => i.message.includes("dostack_query_workflows"))).toBe(true)
  })

  test("does not flag non-empty workflowId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const config = {
  workflows: {
    rfpAnalysis: { workflowId: "wf-abc123", outputMapping: { summary: "rfps.summary" } },
  },
  phases: ["intake"],
}`,
    )
    const state = await scanArtifactState(dir)
    expect(state.issues.some((i) => i.message.includes("rfpAnalysis"))).toBe(false)
  })

  test("extracts wiring when inputMapping appears before workflowId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-issue-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const config = {
  workflows: {
    rfpAnalysis: {
      inputMapping: { rfp_id: "entity.id", content: "entity.body" },
      workflowId: "wf-abc123",
      outputMapping: { summary: "rfps.summary" },
    },
  },
  phases: ["intake", "analysis"],
}`,
    )
    const state = await scanArtifactState(dir)
    expect(state.config.workflows).toHaveLength(1)
    expect(state.config.workflows[0].name).toBe("rfpAnalysis")
    expect(state.config.workflows[0].workflowId).toBe("wf-abc123")
  })

  test("mid-build integration: detects multiple issues simultaneously", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-midbuild-"))

    // Migrations: demo still present + domain migration added
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(
      join(dir, "backend/migrations/001_demo_items.sql"),
      "CREATE TABLE items (id UUID PRIMARY KEY, name TEXT);",
    )
    await writeFile(
      join(dir, "backend/migrations/002_rfps.sql"),
      "CREATE TABLE rfps (id UUID PRIMARY KEY, title TEXT, document_url TEXT);",
    )

    // Config with empty workflowId + icon reference
    await mkdir(join(dir, "frontend/src/domain"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/config.ts"),
      `export const config = {
  workflows: {
    rfpAnalysis: { workflowId: "", outputMapping: { summary: "rfps.summary" } },
  },
  navigation: [
    { label: "RFPs", icon: "FileSearch", path: "/rfps" },
  ],
  phases: ["intake"],
}`,
    )

    // Sidebar with missing icon
    await mkdir(join(dir, "frontend/src/components/layout"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/components/layout/Sidebar.tsx"),
      "const ICON_MAP = { Home: HomeIcon, FileText: FileTextIcon }",
    )

    // Pages created but no FileUpload component
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
    await writeFile(join(dir, "frontend/src/domain/pages/RfpList.tsx"), "export default function RfpList() {}")
    await mkdir(join(dir, "frontend/src/domain/components"), { recursive: true })
    await writeFile(
      join(dir, "frontend/src/domain/components/RfpForm.tsx"),
      'export function RfpForm() { return <input type="text" name="doc" /> }',
    )

    const state = await scanArtifactState(dir)
    const formatted = formatArtifactState(state)

    // Should detect: demo migration, empty workflowId, missing icon, file-type warning
    expect(state.issues.some((i) => i.message.includes("001_demo_items.sql"))).toBe(true)
    expect(state.issues.some((i) => i.message.includes("rfpAnalysis") && i.message.includes("empty workflowId"))).toBe(true)
    expect(state.issues.some((i) => i.message.includes("FileSearch"))).toBe(true)
    expect(state.issues.some((i) => i.type === "warning" && i.message.includes("document_url"))).toBe(true)

    // Formatted output should have Issues section with all of them
    expect(formatted).toContain("### Issues")
    expect(formatted).toContain("[ERROR]")
    expect(formatted).toContain("[WARNING]")
  })

  test("formatArtifactState renders Issues section when issues exist", () => {
    const state = {
      migrations: [],
      config: { workflows: [], phases: [] },
      pages: [],
      gaps: [],
      issues: [{ type: "error" as const, message: "Demo migration still present" }],
    }
    const output = formatArtifactState(state)
    expect(output).toContain("### Issues")
    expect(output).toContain("[ERROR] Demo migration still present")
  })

  test("formatArtifactState omits Issues section when no issues exist", () => {
    const state = {
      migrations: [],
      config: { workflows: [], phases: [] },
      pages: [],
      gaps: [],
      issues: [],
    }
    const output = formatArtifactState(state)
    expect(output).not.toContain("### Issues")
  })
})
