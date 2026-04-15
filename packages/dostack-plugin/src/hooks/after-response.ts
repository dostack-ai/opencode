import { triggerPreview } from "../tools/trigger-preview"

const FILE_WRITE_TOOLS = new Set(["write", "edit"])
const FRONTEND_PREFIXES = ["frontend/"]
const DEBOUNCE_MS = 2_000

const BUILD_COMPLETE_PATTERNS = [
  /build\s+complete/i,
  /all\s+tasks?\s+done/i,
  /all\s+todos?\s+complete/i,
  /ready\s+to\s+deploy/i,
  /build\s+passes?\s+cleanly/i,
]

export function createAfterResponseHook(
  projectDir: string,
  invalidateCache: () => void,
  setVerificationPending: (pending: boolean) => void,
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  return async (
    input: { tool: string; sessionID: string; callID: string; args: any; response?: string },
    _output: { title: string; output: string; metadata: any },
  ) => {
    const responseText = input.response ?? _output.output ?? ""
    if (BUILD_COMPLETE_PATTERNS.some((p) => p.test(responseText))) {
      setVerificationPending(true)
    }

    if (!FILE_WRITE_TOOLS.has(input.tool)) return

    invalidateCache()

    const filePath: string = input.args?.filePath ?? input.args?.file_path ?? input.args?.path ?? ""
    const isFrontend = FRONTEND_PREFIXES.some((p) => filePath.includes(p))

    if (isFrontend) {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        try {
          await triggerPreview(projectDir, {})
        } catch {
          // Preview build failure is non-blocking
        }
      }, DEBOUNCE_MS)
    }
  }
}
