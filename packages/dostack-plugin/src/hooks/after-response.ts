import { triggerPreview } from "../tools/trigger-preview"
import type { EventEmitter } from "../event-emitter"

const FILE_WRITE_TOOLS = new Set(["write", "edit"])
const FRONTEND_PREFIXES = ["frontend/"]
const DEBOUNCE_MS = 2_000

/**
 * after-response hook.
 *
 * Phase 1c: Replaces direct PUT /build-status writes with builder.* event
 * emissions on a coordinator-managed /builds/{job_id}/events route. The
 * events are best-effort (fire-and-forget, non-throwing).
 *
 * Rate-limiting: at most ~one builder.step.progress per build is emitted
 * per second via the same debounce window already in place for preview
 * triggering, plus an internal guard that only re-emits when the file
 * count changes. This keeps us well under the coordinator's sensible
 * rate limit.
 */
export function createAfterResponseHook(
  projectDir: string,
  invalidateCache: () => void,
  onFileWrite?: () => void,
  eventEmitter?: EventEmitter,
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let filesWritten = 0
  let lastProgressEmittedAt = 0

  return async (
    input: { tool: string; sessionID: string; callID: string; args: any },
    _output: { title: string; output: string; metadata: any },
  ) => {
    if (!FILE_WRITE_TOOLS.has(input.tool)) return

    invalidateCache()
    onFileWrite?.()
    filesWritten += 1

    // Emit progress events sparingly — at most one per 3s to stay well under
    // the coordinator's rate limit, no matter how many writes pile up.
    if (eventEmitter) {
      const now = Date.now()
      if (now - lastProgressEmittedAt > 3000) {
        lastProgressEmittedAt = now
        eventEmitter
          .emit("builder.step.progress", { step: "generating", files_written: filesWritten })
          .catch(() => {})
      }
    }

    const filePath: string = input.args?.filePath ?? input.args?.file_path ?? input.args?.path ?? ""
    const isFrontend = FRONTEND_PREFIXES.some((p) => filePath.includes(p))

    if (isFrontend) {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        try {
          await triggerPreview(projectDir, {})
          eventEmitter?.emit("builder.step.progress", { step: "preview_built" }).catch(() => {})
        } catch {
          // Preview build failure is non-blocking
        }
      }, DEBOUNCE_MS)
    }
  }
}

const BUILD_COMPLETE_PATTERNS = [
  /\bbuild\b.{0,20}\bcomplete\b/i,
  /\ball\s+tasks?\s+(?:are\s+)?done\b/i,
  /\ball\s+todos?\s+(?:are\s+)?complete\b/i,
  /\bready\s+to\s+deploy\b/i,
  /\bbuild\s+passes?\s+cleanly\b/i,
]

/**
 * text-complete hook.
 *
 * When the AI signals build-complete and post-build verification has already
 * been performed, this hook calls onBuildComplete which (Phase 1c) runs the
 * package-assembly + POST /complete flow defined in Task 12.
 *
 * The legacy reportComplete path is preserved as a fallback.
 */
export function createTextCompleteHook(
  setVerificationPending: (pending: boolean) => void,
  options?: {
    isVerificationComplete?: () => boolean
    reportComplete?: () => Promise<void>
    onBuildComplete?: () => Promise<void>
  },
) {
  return async (
    _input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => {
    if (!BUILD_COMPLETE_PATTERNS.some((p) => p.test(output.text))) return

    // If verification was already injected and no files written since,
    // the AI reviewed the checklist and is satisfied → signal complete.
    if (options?.isVerificationComplete?.()) {
      if (options.onBuildComplete) {
        options.onBuildComplete().catch((err: unknown) =>
          console.error("Failed to run onBuildComplete:", err),
        )
      } else if (options.reportComplete) {
        options.reportComplete().catch((err: unknown) =>
          console.error("Failed to report build complete:", err),
        )
      }
    } else {
      setVerificationPending(true)
    }
  }
}
