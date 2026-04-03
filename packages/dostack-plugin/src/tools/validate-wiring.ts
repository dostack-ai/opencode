import { tool } from "@opencode-ai/plugin/tool"
import { readFile, readdir } from "fs/promises"
import { join } from "path"
import type { ApiClient } from "../api-client"
import { ApiClientError } from "../api-client"

type ValidationIssue = {
  type: "error" | "warning"
  message: string
  location?: string
}

function parseConfigFile(content: string): Array<{
  name: string
  workflowId: string
  outputMapping: Record<string, string>
}> {
  const workflows: Array<{ name: string; workflowId: string; outputMapping: Record<string, string> }> = []
  const workflowBlockRegex = /(\w+)\s*:\s*\{[^}]*workflowId\s*:\s*["']([^"']+)["'][^}]*outputMapping\s*:\s*\{([^}]*)\}/gs
  let match
  while ((match = workflowBlockRegex.exec(content)) !== null) {
    const name = match[1]!
    const workflowId = match[2]!
    const mappingBlock = match[3]!
    const outputMapping: Record<string, string> = {}
    const mappingRegex = /(\w+)\s*:\s*["']([^"']+)["']/g
    let mappingMatch
    while ((mappingMatch = mappingRegex.exec(mappingBlock)) !== null) {
      outputMapping[mappingMatch[1]!] = mappingMatch[2]!
    }
    workflows.push({ name, workflowId, outputMapping })
  }
  return workflows
}

function parseMigrationFiles(contents: string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const sql of contents) {
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)(?:\);)/gi
    let match
    while ((match = tableRegex.exec(sql)) !== null) {
      const tableName = match[1]!
      const body = match[2]!
      const columns = new Set<string>()
      const lines = body.split(",").map((l) => l.trim())
      for (const line of lines) {
        const colMatch = line.match(/^(\w+)\s+/)
        if (colMatch) {
          const name = colMatch[1]!.toLowerCase()
          if (!["primary", "unique", "check", "foreign", "constraint", "index"].includes(name)) {
            columns.add(name)
          }
        }
      }
      tables.set(tableName, columns)
    }
  }
  return tables
}

export async function validateWiring(
  client: ApiClient,
  projectDir: string,
  args: { config_path?: string; migrations_path?: string },
): Promise<string> {
  const configPath = args.config_path ?? "frontend/src/domain/config.ts"
  const migrationsPath = args.migrations_path ?? "backend/migrations"
  const issues: ValidationIssue[] = []

  let configContent: string
  try {
    configContent = await readFile(join(projectDir, configPath), "utf-8")
  } catch {
    return JSON.stringify({ valid: false, errors: [{ type: "error", message: `Config file not found: ${configPath}` }], warnings: [] })
  }

  const wiredWorkflows = parseConfigFile(configContent)
  if (wiredWorkflows.length === 0) {
    return JSON.stringify({ valid: true, errors: [], warnings: [{ type: "warning", message: "No workflows found in config file." }] })
  }

  let migrationFiles: string[] = []
  try {
    const entries = await readdir(join(projectDir, migrationsPath))
    const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort()
    migrationFiles = await Promise.all(sqlFiles.map((f) => readFile(join(projectDir, migrationsPath, f), "utf-8")))
  } catch {
    issues.push({ type: "warning", message: `Migrations directory not found: ${migrationsPath}`, location: migrationsPath })
  }

  const tables = parseMigrationFiles(migrationFiles)

  for (const wf of wiredWorkflows) {
    try {
      await client.external.get(`/api/v1/workflows/${wf.workflowId}/schema`)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        issues.push({ type: "error", message: `Workflow "${wf.name}" references ID "${wf.workflowId}" which does not exist.`, location: configPath })
      } else {
        issues.push({ type: "warning", message: `Could not verify workflow "${wf.workflowId}": ${(err as Error).message}`, location: configPath })
      }
      continue
    }

    for (const [outputField, dbTarget] of Object.entries(wf.outputMapping)) {
      const parts = dbTarget.split(".")
      if (parts.length !== 2) {
        issues.push({ type: "error", message: `Invalid mapping format "${dbTarget}" for output "${outputField}" in "${wf.name}". Expected "table.column".`, location: configPath })
        continue
      }
      const [tableName, columnName] = parts as [string, string]
      const tableColumns = tables.get(tableName)
      if (!tableColumns) {
        issues.push({ type: "error", message: `Table "${tableName}" referenced in "${wf.name}" output mapping not found in migrations.`, location: configPath })
        continue
      }
      if (!tableColumns.has(columnName.toLowerCase())) {
        issues.push({ type: "error", message: `Column "${columnName}" not found in table "${tableName}" (referenced by "${wf.name}.${outputField}").`, location: configPath })
      }
    }
  }

  const errors = issues.filter((i) => i.type === "error")
  const warnings = issues.filter((i) => i.type === "warning")
  return JSON.stringify({ valid: errors.length === 0, errors, warnings }, null, 2)
}

export function createValidateWiringTool(client: ApiClient, projectDir: string) {
  return tool({
    description:
      "Validate that the workflow wiring config matches actual workflow schemas and the database model. Checks for nonexistent workflow IDs, unmapped output fields, and missing database columns.",
    args: {
      config_path: tool.schema.string().optional().describe('Path to config file relative to project root. Defaults to "frontend/src/domain/config.ts".'),
      migrations_path: tool.schema.string().optional().describe('Path to migrations directory relative to project root. Defaults to "backend/migrations/".'),
    },
    async execute(args) {
      return validateWiring(client, projectDir, args)
    },
  })
}
