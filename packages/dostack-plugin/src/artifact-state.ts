import { readFile, readdir } from "fs/promises"
import { join } from "path"

export type MigrationInfo = {
  file: string
  tables: string[]
  columnCount: number
}

export type WiringInfo = {
  name: string
  workflowId: string
  outputFieldCount: number
}

export type WorkflowGapInfo = {
  name: string
  status: string
  capabilityTypes: string[]
}

export type ArtifactState = {
  migrations: MigrationInfo[]
  config: {
    workflows: WiringInfo[]
    phases: string[]
  }
  pages: string[]
  gaps: WorkflowGapInfo[]
}

function extractTables(sql: string): { tables: string[]; columnCount: number } {
  const tables: string[] = []
  let totalColumns = 0

  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)(?:\);)/gi
  let match
  while ((match = tableRegex.exec(sql)) !== null) {
    tables.push(match[1]!)
    const body = match[2]!
    const lines = body.split(",").map((l) => l.trim())
    for (const line of lines) {
      const colMatch = line.match(/^(\w+)\s+/)
      if (colMatch) {
        const name = colMatch[1]!.toLowerCase()
        if (!["primary", "unique", "check", "foreign", "constraint", "index"].includes(name)) {
          totalColumns++
        }
      }
    }
  }

  return { tables, columnCount: totalColumns }
}

function extractWiring(content: string): { workflows: WiringInfo[]; phases: string[] } {
  const workflows: WiringInfo[] = []

  // Match entries like: name: { workflowId: "...", outputMapping: { ... } }
  // Use a two-step approach: first find workflowId entries, then backtrack to find the key name
  const wfIdRegex = /(\w+)\s*:\s*\{[^{}]*workflowId\s*:\s*["']([^"']+)["'][^{}]*outputMapping\s*:\s*\{([^{}]*)\}/g
  let match
  while ((match = wfIdRegex.exec(content)) !== null) {
    const mappingBlock = match[3]!
    const fieldCount = (mappingBlock.match(/\w+\s*:/g) ?? []).length
    workflows.push({ name: match[1]!, workflowId: match[2]!, outputFieldCount: fieldCount })
  }

  const phases: string[] = []
  const phaseMatch = content.match(/phases\s*:\s*\[([\s\S]*?)\]/)
  if (phaseMatch) {
    const phaseRegex = /["']([^"']+)["']/g
    let pm
    while ((pm = phaseRegex.exec(phaseMatch[1]!)) !== null) {
      phases.push(pm[1]!)
    }
  }

  return { workflows, phases }
}

export async function scanArtifactState(projectDir: string): Promise<ArtifactState> {
  const migrations: MigrationInfo[] = []
  try {
    const entries = await readdir(join(projectDir, "backend/migrations"))
    const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort()
    for (const file of sqlFiles) {
      const sql = await readFile(join(projectDir, "backend/migrations", file), "utf-8")
      const { tables, columnCount } = extractTables(sql)
      migrations.push({ file, tables, columnCount })
    }
  } catch {}

  let config: { workflows: WiringInfo[]; phases: string[] } = { workflows: [], phases: [] }
  try {
    const content = await readFile(join(projectDir, "frontend/src/domain/config.ts"), "utf-8")
    config = extractWiring(content)
  } catch {}

  let pages: string[] = []
  try {
    const entries = await readdir(join(projectDir, "frontend/src/domain/pages"))
    pages = entries.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts")).sort()
  } catch {}

  let gaps: WorkflowGapInfo[] = []
  try {
    const content = await readFile(join(projectDir, ".dostack/workflow-status.json"), "utf-8")
    const data = JSON.parse(content)
    gaps = (data.workflows ?? []).map((w: any) => ({
      name: w.name,
      status: w.status,
      capabilityTypes: w.capability_types ?? [],
    }))
  } catch {}

  return { migrations, config, pages, gaps }
}

export function formatArtifactState(state: ArtifactState): string {
  const lines: string[] = ["## Current Project State", ""]

  lines.push("### Migrations")
  if (state.migrations.length === 0) {
    lines.push("- (none)")
  } else {
    for (const m of state.migrations) {
      lines.push(`- ${m.file}: ${m.tables.join(", ")} (${m.columnCount} columns)`)
    }
  }
  lines.push("")

  lines.push("### Workflow Wiring (config.ts)")
  if (state.config.workflows.length === 0) {
    lines.push("- (none)")
  } else {
    for (const w of state.config.workflows) {
      lines.push(`- ${w.name} (${w.workflowId}): wired, ${w.outputFieldCount} output fields mapped`)
    }
  }
  if (state.config.phases.length > 0) {
    lines.push(`- Phases: ${state.config.phases.join(" → ")}`)
  }
  lines.push("")

  lines.push("### Pages")
  if (state.pages.length === 0) {
    lines.push("- (none)")
  } else {
    lines.push(`- ${state.pages.join(", ")}`)
  }
  lines.push("")

  if (state.gaps.length > 0) {
    lines.push("### Workflow Gaps")
    for (const g of state.gaps) {
      lines.push(`- [${g.status}] ${g.name} (${g.capabilityTypes.join(", ")})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
