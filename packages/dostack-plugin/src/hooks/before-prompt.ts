import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scanArtifactState, formatArtifactState, type ArtifactState } from "../artifact-state"
import type { ApiClient } from "../api-client"

const CACHE_TTL_MS = 10_000
const REGISTRY_TTL_MS = 60_000

async function loadSystemPrompt(): Promise<string> {
  const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../system-prompt.md")
  return readFile(promptPath, "utf-8")
}

type WorkflowEntry = {
  workflow_id?: string
  id?: string
  name?: string
  current_version?: number
  version?: number
  step_types?: string[]
  capability_types?: string[]
}

function formatRegistry(workflows: WorkflowEntry[]): string {
  if (!workflows || workflows.length === 0) return ""
  const lines: string[] = ["### Workflow Registry"]
  for (const wf of workflows) {
    const id = wf.workflow_id ?? wf.id ?? "unknown"
    const name = wf.name ?? id
    const version = wf.current_version ?? wf.version ?? "?"
    const types = wf.step_types ?? wf.capability_types ?? []
    const typeStr = types.length > 0 ? `, ${types[0]}` : ""
    lines.push(`- ${name} (${id}) — v${version}${typeStr}`)
  }
  return lines.join("\n")
}

export function createBeforePromptHook(projectDir: string, client?: ApiClient) {
  let cachedState: ArtifactState | null = null
  let cacheTimestamp = 0
  let systemPromptCache: string | null = null
  let registryCache: string | null = null
  let registryTimestamp = 0

  const invalidate = () => {
    cachedState = null
    cacheTimestamp = 0
  }

  const hook = async (
    _input: { sessionID?: string; model: any },
    output: { system: string[] },
  ) => {
    if (!systemPromptCache) {
      systemPromptCache = await loadSystemPrompt()
    }
    output.system.push(systemPromptCache)

    const now = Date.now()
    if (!cachedState || now - cacheTimestamp > CACHE_TTL_MS) {
      cachedState = await scanArtifactState(projectDir)
      cacheTimestamp = now
    }

    output.system.push(formatArtifactState(cachedState))

    if (client) {
      if (!registryCache || now - registryTimestamp > REGISTRY_TTL_MS) {
        try {
          const data = (await client.external.get("/api/v1/workflows")) as { workflows?: WorkflowEntry[] }
          registryCache = formatRegistry(data.workflows ?? [])
          registryTimestamp = now
        } catch {
          // Skip silently on error
        }
      }
      if (registryCache) {
        output.system.push(registryCache)
      }
    }
  }

  return { hook, invalidate }
}
