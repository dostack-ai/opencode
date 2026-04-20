import { tool } from "@opencode-ai/plugin/tool"
import { readdir } from "fs/promises"

/**
 * dostack_build_complete tool.
 *
 * Phase 1c Task 0A v2: replaces inference-based completion detection
 * (experimental.text.complete regex, bus-event watchers) with an explicit
 * tool call the LLM issues exactly once when the build is fully done.
 *
 * Rationale: experimental.text.complete only fires on text-end stream
 * events, and Claude's final turn often exits via `finish`, bypassing it.
 * Bus events like message.updated / message.part.updated fire per-turn,
 * not per-session — agentic loops have no structural session-complete
 * signal, so the agent itself must emit one.
 *
 * Handler runs the same assembleAndUploadPackage + postComplete flow the
 * textComplete hook uses. An idempotency flag (held in the plugin closure,
 * shared with the textComplete path) guarantees whichever path fires first
 * wins and later fires are no-ops.
 */
export function createBuildCompleteTool(deps: {
  projectDir: string
  isCompletionInvoked: () => boolean
  setCompletionInvoked: (v: boolean) => void
  runBuildComplete: () => Promise<void>
}) {
  return tool({
    description:
      "Call this EXACTLY ONCE when the entire app has been built and " +
      "all files are written to /workspace/template. This tool signals " +
      "that the build is complete and triggers the package upload to " +
      "the coordinator. Do NOT call this tool partway through the build " +
      "— only call after every file is written and you are fully done.",
    args: {
      summary: tool.schema
        .string()
        .describe("One sentence describing what was built."),
    },
    async execute(args) {
      if (deps.isCompletionInvoked()) {
        return JSON.stringify({
          ok: false,
          error: "build_complete already called; build is finalizing.",
        })
      }
      // Sanity check: reject if no files in /workspace/template beyond dotfiles.
      try {
        const files = await readdir(deps.projectDir, { recursive: true })
        const meaningful = files.filter(
          (f) => typeof f === "string" && !f.startsWith("."),
        )
        if (meaningful.length === 0) {
          return JSON.stringify({
            ok: false,
            error:
              "no files detected in /workspace/template; please write " +
              "files before calling dostack_build_complete.",
          })
        }
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `filesystem check failed: ${String(err)}`,
        })
      }
      deps.setCompletionInvoked(true)
      try {
        await deps.runBuildComplete()
      } catch (err) {
        // Leave completionInvoked=true so we don't retry on a second call.
        return JSON.stringify({
          ok: false,
          error: `buildComplete failed: ${String(err)}`,
        })
      }
      return JSON.stringify({
        ok: true,
        summary: args.summary,
        status: "package_uploaded",
      })
    },
  })
}
