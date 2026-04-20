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
  // Deterministic marker (preferred). System prompt instructs the LLM to emit
  // the literal line `BUILD_COMPLETE.` when done. The /mi flags allow any
  // casing on its own line.
  /^BUILD_COMPLETE\.?\s*$/im,
  /\bbuild\b.{0,20}\bcomplete\b/i,
  /\ball\s+tasks?\s+(?:are\s+)?done\b/i,
  /\ball\s+todos?\s+(?:are\s+)?complete\b/i,
  /\bready\s+to\s+deploy\b/i,
  /\bbuild\s+passes?\s+cleanly\b/i,
  // Heuristic wrap-ups the LLM may use even without the marker.
  /\b(?:build|project)\s+is\s+(?:complete|done|ready|finished)\b/i,
  /\b(?:all|everything)\s+(?:files|pages|done)\b.*?\b(?:generated|created|built)\b/i,
  /\b(?:i've|i have)\s+(?:finished|completed|built)\b/i,
]

/**
 * Silence-timeout fallback state.
 *
 * If the LLM emits a non-trivial text chunk that does not match any
 * completion pattern, we start (or reset) a single module-level timer.
 * If no further textComplete hook fires within
 * `BUILDER_SILENCE_TIMEOUT_SEC` seconds (default 60), we treat the build
 * as complete by invoking the same completion code path as a pattern
 * match. This protects against phrasings we haven't yet added to the
 * regex list.
 *
 * The timer is always cleared once we dispatch completion (success or
 * failure), so a later chunk cannot double-fire.
 */
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let completionDispatched = false

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }
}

function silenceTimeoutMs(): number {
  const raw = process.env.BUILDER_SILENCE_TIMEOUT_SEC
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  const secs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60
  return secs * 1000
}

// Exported for tests only: lets the test suite reset module-level state
// between cases. Not part of the runtime plugin contract.
export function __resetTextCompleteStateForTests() {
  clearSilenceTimer()
  completionDispatched = false
}

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
  const dispatchCompletion = () => {
    if (completionDispatched) return
    completionDispatched = true
    clearSilenceTimer()

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
      // Verification isn't complete yet; allow a future textComplete to
      // re-trigger dispatch after the builder reviews the checklist.
      completionDispatched = false
    }
  }

  return async (
    _input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => {
    if (BUILD_COMPLETE_PATTERNS.some((p) => p.test(output.text))) {
      dispatchCompletion()
      return
    }

    // Silence-timeout fallback. Only arm the timer for non-trivial text
    // chunks (>= 40 chars) to avoid spurious triggers on very short
    // tool-result echoes or partial streams.
    if (!completionDispatched && output.text && output.text.length >= 40) {
      clearSilenceTimer()
      silenceTimer = setTimeout(() => {
        silenceTimer = null
        console.warn(
          "[dostack-plugin] silence timeout fired — treating build as complete " +
            "(no BUILD_COMPLETE marker or heuristic match seen)",
        )
        dispatchCompletion()
      }, silenceTimeoutMs())
    }
  }
}
