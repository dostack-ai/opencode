import { readFile, stat } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scanArtifactState, formatArtifactState, type ArtifactState } from "../artifact-state"
import type { ApiClient } from "../api-client"
import type { DostackConfig } from "../config"
import type { BuildRequest } from "../build-request"
import { getRuntimeErrors } from "../tools/get-runtime-errors"

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

const VERIFICATION_CHECKLIST = `## Post-Build Verification Required

Before declaring the build complete, run these checks:
1. Call dostack_validate_wiring to verify workflow config consistency
2. Call dostack_trigger_preview to verify the frontend builds cleanly
3. Review the Issues section in the artifact state above — fix any flagged problems
4. Verify you deleted demo files (001_demo_items.sql, ItemsList.tsx, ItemDetail.tsx, ItemForm.tsx)

Do not report completion until all checks pass.`

const RUNTIME_ERRORS_TTL_MS = 30_000

type RuntimeErrorOptions = {
  config: DostackConfig
  fetchErrors?: (config: DostackConfig, args: { minutes?: number }) => Promise<string>
  buildRequest?: BuildRequest | null
}

function formatBuildRequest(br: BuildRequest): string {
  const lines: string[] = ["## Build Request (authoritative spec + workflow bindings)"]
  lines.push("")
  lines.push(
    "This build request was uploaded by the DOstack coordinator before this task started. " +
      "Use it as the authoritative source of truth for identity, entities, roles, actions, " +
      "ui_intent, and workflow bindings. Do NOT infer these from chat history.",
  )
  lines.push("")

  // Identity + spec summary
  const spec = br.spec ?? ({} as BuildRequest["spec"])
  const identity = (spec.identity ?? {}) as { name?: string; slug?: string; description?: string }
  lines.push("### Identity")
  lines.push(`- name: ${identity.name ?? "(unset)"}`)
  lines.push(`- slug: ${identity.slug ?? "(unset)"}`)
  lines.push(`- description: ${identity.description ?? "(unset)"}`)
  lines.push(`- spec_version: ${spec.spec_version ?? "(unset)"}`)
  lines.push(`- template_version: ${br.template_version ?? "(unset)"}`)
  lines.push(`- build_job_id: ${br.build_job_id}`)
  lines.push(`- workbench_id: ${br.workbench_id}`)
  lines.push("")

  // Entities
  lines.push("### Entities")
  if (!spec.entities || spec.entities.length === 0) {
    lines.push("(none)")
  } else {
    lines.push("```json")
    lines.push(JSON.stringify(spec.entities, null, 2))
    lines.push("```")
  }
  lines.push("")

  // Roles
  lines.push("### Roles")
  if (!spec.roles || spec.roles.length === 0) {
    lines.push("(none)")
  } else {
    lines.push("```json")
    lines.push(JSON.stringify(spec.roles, null, 2))
    lines.push("```")
  }
  lines.push("")

  // Actions
  lines.push("### Actions")
  if (!spec.actions || spec.actions.length === 0) {
    lines.push("(none)")
  } else {
    lines.push("```json")
    lines.push(JSON.stringify(spec.actions, null, 2))
    lines.push("```")
  }
  lines.push("")

  // UI intent
  lines.push("### UI Intent")
  lines.push("```json")
  lines.push(JSON.stringify(spec.ui_intent ?? {}, null, 2))
  lines.push("```")
  lines.push("")

  // Workflow bindings (one per action with type=workflow)
  lines.push("### Workflow Bindings")
  if (!br.workflow_bindings || br.workflow_bindings.length === 0) {
    lines.push("(no workflow bindings — this app has no workflow-backed actions)")
  } else {
    for (const binding of br.workflow_bindings) {
      lines.push(`#### ${binding.name} (${binding.workflow_id} @ ${binding.version_id})`)
      lines.push("```json")
      lines.push(JSON.stringify(binding, null, 2))
      lines.push("```")
      lines.push("")
    }
  }
  return lines.join("\n")
}

export function createBeforePromptHook(projectDir: string, client?: ApiClient, runtimeErrorOptions?: RuntimeErrorOptions) {
  let cachedState: ArtifactState | null = null
  let cacheTimestamp = 0
  let systemPromptCache: string | null = null
  let registryCache: string | null = null
  let registryTimestamp = 0
  let verificationPending = false
  let verificationInjected = false
  let runtimeErrorsCache: string | null = null
  let runtimeErrorsTimestamp = 0

  async function shouldQueryRuntimeErrors(): Promise<boolean> {
    try {
      await stat(join(projectDir, ".dostack/preview-ready"))
      return true
    } catch {
      return false
    }
  }

  function formatRuntimeErrors(resultJson: string): string | null {
    try {
      const result = JSON.parse(resultJson)
      if (!result.errors || result.errors.length === 0) return null
      const lines: string[] = ["### Recent Runtime Errors"]
      for (const err of result.errors.slice(0, 10)) {
        lines.push(`- [${err.timestamp}] **${err.function}**: ${err.message}`)
      }
      if (result.truncated || result.errors.length > 10) {
        lines.push(`- _(${result.errors.length} total errors — showing first 10)_`)
      }
      return lines.join("\n")
    } catch {
      return null
    }
  }

  const invalidate = () => {
    cachedState = null
    cacheTimestamp = 0
    verificationInjected = false
  }

  const setVerificationPending = (pending: boolean) => {
    if (pending && !verificationInjected) {
      verificationPending = true
    }
  }

  const hook = async (
    _input: { sessionID?: string; model: any },
    output: { system: string[] },
  ) => {
    if (!systemPromptCache) {
      systemPromptCache = await loadSystemPrompt()
    }
    output.system.push(systemPromptCache)

    // Phase 1c: inject the authoritative build request (spec + workflow bindings)
    // so Claude sees the structured intent directly rather than reconstructing it
    // from conversation history.
    if (runtimeErrorOptions?.buildRequest) {
      output.system.push(formatBuildRequest(runtimeErrorOptions.buildRequest))
    }

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

    if (verificationPending && !verificationInjected) {
      output.system.push(VERIFICATION_CHECKLIST)
      verificationInjected = true
      verificationPending = false
    }

    // Inject runtime errors when a deploy signal is present
    if (runtimeErrorOptions) {
      const shouldQuery = await shouldQueryRuntimeErrors()
      if (shouldQuery) {
        if (runtimeErrorsTimestamp === 0 || now - runtimeErrorsTimestamp > RUNTIME_ERRORS_TTL_MS) {
          try {
            const fetcher = runtimeErrorOptions.fetchErrors ?? getRuntimeErrors
            const result = await fetcher(runtimeErrorOptions.config, { minutes: 15 })
            runtimeErrorsCache = formatRuntimeErrors(result)
            runtimeErrorsTimestamp = now
          } catch {
            // Silently skip on error
          }
        }
        if (runtimeErrorsCache) {
          output.system.push(runtimeErrorsCache)
        }
      }
    }
  }

  const isVerificationComplete = () => verificationInjected

  return { hook, invalidate, setVerificationPending, isVerificationComplete }
}
