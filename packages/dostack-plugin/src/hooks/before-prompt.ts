import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scanArtifactState, formatArtifactState, type ArtifactState } from "../artifact-state"

let cachedState: ArtifactState | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 10_000

async function loadSystemPrompt(): Promise<string> {
  const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../system-prompt.md")
  return readFile(promptPath, "utf-8")
}

let systemPromptCache: string | null = null

export function invalidateArtifactCache() {
  cachedState = null
  cacheTimestamp = 0
}

export function createBeforePromptHook(projectDir: string) {
  return async (
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
  }
}
