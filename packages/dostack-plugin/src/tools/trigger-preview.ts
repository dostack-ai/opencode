import { tool } from "@opencode-ai/plugin/tool"
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

type BuildError = {
  file?: string
  line?: number
  message: string
}

function parseErrors(output: string): BuildError[] {
  const errors: BuildError[] = []
  const pattern = /(?:([^\s]+)\((\d+),\d+\):\s*error\s+.+?:\s*(.+)|error\s+.+?:\s*(.+))/g
  let match
  while ((match = pattern.exec(output)) !== null) {
    if (match[1]) {
      errors.push({ file: match[1], line: parseInt(match[2]!, 10), message: match[3]! })
    } else if (match[4]) {
      errors.push({ message: match[4] })
    }
  }
  if (errors.length === 0 && output.trim()) {
    errors.push({ message: output.trim().slice(0, 500) })
  }
  return errors
}

export async function triggerPreview(
  projectDir: string,
  args: { check_only?: boolean },
): Promise<string> {
  const command = args.check_only ? "npm run typecheck --if-present" : "npm run build --if-present"
  const start = Date.now()

  try {
    await execAsync(command, {
      cwd: projectDir,
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: "production" },
    })

    const buildTimeMs = Date.now() - start

    await mkdir(join(projectDir, ".dostack"), { recursive: true })
    await writeFile(join(projectDir, ".dostack/preview-ready"), new Date().toISOString())

    return JSON.stringify({ success: true, buildTimeMs })
  } catch (err: any) {
    const buildTimeMs = Date.now() - start
    const output = (err.stderr?.toString() ?? "") + (err.stdout?.toString() ?? "")
    const errors = parseErrors(output)

    return JSON.stringify({ success: false, errors, buildTimeMs })
  }
}

export function createTriggerPreviewTool(projectDir: string) {
  return tool({
    description:
      "Build the workbench frontend and signal the preview to reload. Run this after editing frontend files to update the live preview.",
    args: {
      check_only: tool.schema
        .boolean()
        .optional()
        .describe("If true, run type-check only (faster) instead of full build."),
    },
    async execute(args) {
      return triggerPreview(projectDir, args)
    },
  })
}
