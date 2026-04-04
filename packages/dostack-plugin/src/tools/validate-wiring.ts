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

// Returns Map<tableName, Map<columnName, columnType>>
function parseMigrationFiles(contents: string[]): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>()
  for (const sql of contents) {
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)(?:\);)/gi
    let match
    while ((match = tableRegex.exec(sql)) !== null) {
      const tableName = match[1]!
      const body = match[2]!
      const columns = new Map<string, string>()
      const lines = body.split(",").map((l) => l.trim())
      for (const line of lines) {
        const colMatch = line.match(/^(\w+)\s+(\w+)/)
        if (colMatch) {
          const name = colMatch[1]!.toLowerCase()
          const colType = colMatch[2]!.toUpperCase()
          if (!["primary", "unique", "check", "foreign", "constraint", "index"].includes(name)) {
            columns.set(name, colType)
          }
        }
      }
      tables.set(tableName, columns)
    }
  }
  return tables
}

type OutputFieldInfo = {
  fieldName: string
  fieldType: string // "string" | "number" | "boolean" | "array" | "object"
  stepKey: string
}

// Derive a simple type category from a JSON schema type
function normalizeSchemaType(schemaType: unknown): string {
  if (typeof schemaType === "string") return schemaType
  if (typeof schemaType === "object" && schemaType !== null && "type" in schemaType) {
    return (schemaType as any).type ?? "object"
  }
  return "object"
}

// Check if an output field type is compatible with a Postgres column type
function isTypeCompatible(outputType: string, pgType: string): boolean {
  const pg = pgType.toUpperCase()
  switch (outputType) {
    case "string":
      return ["TEXT", "VARCHAR", "CHAR", "CHARACTER VARYING", "CHARACTER"].some((t) => pg.startsWith(t))
    case "number":
      return ["INTEGER", "INT", "NUMERIC", "DECIMAL", "FLOAT", "REAL", "BIGINT", "SMALLINT", "DOUBLE"].some((t) =>
        pg.startsWith(t),
      )
    case "boolean":
      return pg === "BOOLEAN" || pg === "BOOL"
    case "array":
    case "object":
      return pg === "JSONB" || pg === "JSON"
    default:
      return true // unknown type — don't warn
  }
}

// Try to collect all output fields from step structured output schemas
function collectOutputFields(
  steps: Array<{ step_key: string; step_name: string; structured_output_schema: unknown }>,
): OutputFieldInfo[] {
  const fields: OutputFieldInfo[] = []
  for (const step of steps) {
    const schema = step.structured_output_schema as any
    if (!schema || typeof schema !== "object") continue
    // Support both top-level properties and { type: "object", properties: { ... } }
    const properties: Record<string, any> = schema.properties ?? (schema.type === "object" ? {} : schema)
    if (!properties || typeof properties !== "object") continue
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
      fields.push({
        fieldName,
        fieldType: normalizeSchemaType(fieldDef),
        stepKey: step.step_key,
      })
    }
  }
  return fields
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
    let externalSchema: { workflow_id: string; version_id: string } | undefined
    try {
      externalSchema = (await client.external.get(`/api/v1/workflows/${wf.workflowId}/schema`)) as {
        workflow_id: string
        version_id: string
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        issues.push({ type: "error", message: `Workflow "${wf.name}" references ID "${wf.workflowId}" which does not exist.`, location: configPath })
      } else {
        issues.push({ type: "warning", message: `Could not verify workflow "${wf.workflowId}": ${(err as Error).message}`, location: configPath })
      }
      continue
    }

    // Try to fetch step output schemas from internal API
    let outputFields: OutputFieldInfo[] | undefined
    try {
      const versionId = externalSchema.version_id
      const versionData = (await client.internal.get(`/workflow/${wf.workflowId}/versions/${versionId}`)) as {
        steps: Array<{ step_key: string; step_name: string; structured_output_schema: unknown }>
      }
      if (Array.isArray(versionData.steps)) {
        outputFields = collectOutputFields(versionData.steps)
      }
    } catch {
      // Internal API not configured or unavailable — skip schema-based checks
    }

    // Check for unmapped workflow output fields
    if (outputFields && outputFields.length > 0) {
      const mappedFields = new Set(Object.keys(wf.outputMapping))
      for (const field of outputFields) {
        if (!mappedFields.has(field.fieldName)) {
          issues.push({
            type: "warning",
            message: `Workflow output field '${field.fieldName}' from step '${field.stepKey}' is not mapped in config.`,
            location: configPath,
          })
        }
      }
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
        continue
      }

      // Type mismatch check
      if (outputFields) {
        const fieldInfo = outputFields.find((f) => f.fieldName === outputField)
        if (fieldInfo) {
          const pgType = tableColumns.get(columnName.toLowerCase())!
          if (!isTypeCompatible(fieldInfo.fieldType, pgType)) {
            issues.push({
              type: "warning",
              message: `Type mismatch: workflow output '${outputField}' is type '${fieldInfo.fieldType}' but mapped to column '${columnName}' of type '${pgType}'.`,
              location: configPath,
            })
          }
        }
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
      "Validate that the workflow wiring config matches actual workflow schemas and the database model. Checks for nonexistent workflow IDs, unmapped output fields, type mismatches, and missing database columns.",
    args: {
      config_path: tool.schema.string().optional().describe('Path to config file relative to project root. Defaults to "frontend/src/domain/config.ts".'),
      migrations_path: tool.schema.string().optional().describe('Path to migrations directory relative to project root. Defaults to "backend/migrations/".'),
    },
    async execute(args) {
      return validateWiring(client, projectDir, args)
    },
  })
}
