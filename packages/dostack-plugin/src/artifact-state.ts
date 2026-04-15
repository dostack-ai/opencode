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

export type Issue = {
  type: "error" | "warning"
  message: string
}

export type ArtifactState = {
  migrations: MigrationInfo[]
  config: {
    workflows: WiringInfo[]
    phases: string[]
  }
  pages: string[]
  gaps: WorkflowGapInfo[]
  issues: Issue[]
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

const BASE_TABLES = new Set(["users", "notifications", "activities", "comments", "files", "_migrations"])

async function detectIssues(projectDir: string, migrations: MigrationInfo[]): Promise<Issue[]> {
  const issues: Issue[] = []

  // a) Demo file check
  try {
    const hasDemoMigration = migrations.some((m) => m.file === "001_demo_items.sql")
    const hasOtherDomainMigrations = migrations.some(
      (m) => m.file !== "001_demo_items.sql" && !m.file.startsWith("000_"),
    )
    if (hasDemoMigration && hasOtherDomainMigrations) {
      issues.push({ type: "error", message: "Demo migration still present — delete 001_demo_items.sql" })
    }
  } catch {}

  // b) Entity registration check
  try {
    const yamlContent = await readFile(join(projectDir, "workbench-template.yaml"), "utf-8")
    const allowedMatch = yamlContent.match(/ALLOWED_ENTITY_TYPES:\s*"([^"]*)"/)
    if (allowedMatch) {
      const allowedTypes = new Set(allowedMatch[1]!.split(",").map((s) => s.trim()).filter(Boolean))
      const allTables = migrations.flatMap((m) => m.tables)
      for (const table of allTables) {
        if (!BASE_TABLES.has(table) && !allowedTypes.has(table)) {
          issues.push({
            type: "error",
            message: `Table "${table}" exists in migrations but is not registered in ALLOWED_ENTITY_TYPES`,
          })
        }
      }
    }
  } catch {}

  // c) Icon map check
  try {
    const configContent = await readFile(join(projectDir, "frontend/src/domain/config.ts"), "utf-8")
    const sidebarContent = await readFile(
      join(projectDir, "frontend/src/components/layout/Sidebar.tsx"),
      "utf-8",
    )

    const configIcons = new Set<string>()
    const iconRegex = /icon\s*:\s*["'](\w+)["']/g
    let iconMatch
    while ((iconMatch = iconRegex.exec(configContent)) !== null) {
      configIcons.add(iconMatch[1]!)
    }

    const mapIcons = new Set<string>()
    const mapBlockMatch = sidebarContent.match(/ICON_MAP\s*=\s*\{([^}]+)\}/)
    if (mapBlockMatch) {
      const keyRegex = /(\w+)\s*:/g
      let keyMatch
      while ((keyMatch = keyRegex.exec(mapBlockMatch[1]!)) !== null) {
        mapIcons.add(keyMatch[1]!)
      }
    }

    for (const icon of configIcons) {
      if (!mapIcons.has(icon)) {
        issues.push({
          type: "error",
          message: `Icon "${icon}" is referenced in config but missing from ICON_MAP in Sidebar`,
        })
      }
    }
  } catch {}

  // d) File-type field check (heuristic)
  try {
    const fileColumns: string[] = []
    for (const m of migrations) {
      const sql = await readFile(join(projectDir, "backend/migrations", m.file), "utf-8")
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s*\(([\s\S]*?)(?:\);)/gi
      let tableMatch
      while ((tableMatch = tableRegex.exec(sql)) !== null) {
        const body = tableMatch[1]!
        const lines = body.split(",").map((l) => l.trim())
        for (const line of lines) {
          const colMatch = line.match(/^(\w+)\s+TEXT/i)
          if (colMatch) {
            const colName = colMatch[1]!
            if (/document|file|attachment/i.test(colName)) {
              fileColumns.push(colName)
            }
          }
        }
      }
    }

    if (fileColumns.length > 0) {
      const componentDir = join(projectDir, "frontend/src/domain/components")
      const entries = await readdir(componentDir)
      let hasFileUpload = false
      for (const entry of entries) {
        const content = await readFile(join(componentDir, entry), "utf-8")
        if (content.includes("FileUpload")) {
          hasFileUpload = true
          break
        }
      }
      if (!hasFileUpload) {
        for (const col of fileColumns) {
          issues.push({
            type: "warning",
            message: `Column "${col}" looks like a file reference but no component uses FileUpload — use FileUpload instead of text input`,
          })
        }
      }
    }
  } catch {}

  return issues
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

  const issues = await detectIssues(projectDir, migrations)

  return { migrations, config, pages, gaps, issues }
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

  if (state.issues.length > 0) {
    lines.push("### Issues")
    for (const issue of state.issues) {
      const prefix = issue.type === "error" ? "ERROR" : "WARNING"
      lines.push(`- [${prefix}] ${issue.message}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
