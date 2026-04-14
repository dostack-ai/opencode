import { tool } from "@opencode-ai/plugin/tool"
import { execFile } from "child_process"
import { promisify } from "util"
import type { DostackConfig } from "../config"

const execFileAsync = promisify(execFile)

type LogEntry = {
  timestamp: string
  function: string
  message: string
}

type RuntimeErrorsResult = {
  slug: string
  errors: LogEntry[]
  logGroups: string[]
  timeWindowMinutes: number
  truncated: boolean
  message?: string
}

function resolveSlug(config: DostackConfig): string {
  return config.workbench_slug || process.env.WORKBENCH_SLUG || ""
}

async function discoverLogGroups(slug: string): Promise<string[]> {
  const prefix = `/aws/lambda/dostack-wb-app-${slug}`
  const { stdout } = await execFileAsync(
    "aws",
    [
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      prefix,
      "--query",
      "logGroups[*].logGroupName",
      "--output",
      "json",
    ],
    { timeout: 15_000 },
  )
  return JSON.parse(stdout.trim()) as string[]
}

function extractFunctionName(logGroup: string, slug: string): string {
  const prefix = `/aws/lambda/dostack-wb-app-${slug}-`
  if (logGroup.startsWith(prefix)) {
    return logGroup.slice(prefix.length)
  }
  return logGroup
}

function cleanMessage(message: string): string {
  return message.trim().slice(0, 500)
}

async function queryLogGroup(
  logGroup: string,
  slug: string,
  startTimeMs: number,
  filterPattern: string,
  limit: number,
): Promise<LogEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      "aws",
      [
        "logs",
        "filter-log-events",
        "--log-group-name",
        logGroup,
        "--start-time",
        String(startTimeMs),
        "--filter-pattern",
        filterPattern,
        "--limit",
        String(limit),
        "--query",
        "events[*].[timestamp, message]",
        "--output",
        "json",
      ],
      { timeout: 15_000 },
    )
    const events = JSON.parse(stdout.trim()) as Array<[number, string]>
    const funcName = extractFunctionName(logGroup, slug)
    return events.map(([ts, msg]) => ({
      timestamp: new Date(ts).toISOString(),
      function: funcName,
      message: cleanMessage(msg),
    }))
  } catch {
    return []
  }
}

export async function getRuntimeErrors(
  config: DostackConfig,
  args: { minutes?: number; function_name?: string; filter?: string },
): Promise<string> {
  const slug = resolveSlug(config)
  if (!slug) {
    return JSON.stringify({
      error:
        "No workbench slug available. Cannot determine which CloudWatch log groups to query.",
      hint: "WORKBENCH_SLUG env var or workbench_slug config must be set.",
    })
  }

  const minutes = args.minutes ?? 15
  const startTimeMs = Date.now() - minutes * 60 * 1000
  const filterPattern = args.filter ?? "?ERROR ?Exception ?Traceback ?error"
  const maxPerGroup = 20

  let logGroups: string[]
  try {
    logGroups = await discoverLogGroups(slug)
  } catch (err: any) {
    return JSON.stringify({
      error: `Failed to discover log groups: ${err.message}`,
      hint: "Check that AWS credentials are available and the workbench backend is deployed.",
    })
  }

  if (logGroups.length === 0) {
    return JSON.stringify({
      slug,
      errors: [],
      logGroups: [],
      timeWindowMinutes: minutes,
      truncated: false,
      message: `No CloudWatch log groups found matching /aws/lambda/dostack-wb-app-${slug}-*. The backend may not be deployed yet.`,
    })
  }

  // Filter to a specific function if requested
  let targetGroups = logGroups
  if (args.function_name) {
    const search = args.function_name.toLowerCase()
    targetGroups = logGroups.filter((g) => g.toLowerCase().includes(search))
    if (targetGroups.length === 0) {
      return JSON.stringify({
        slug,
        errors: [],
        logGroups,
        timeWindowMinutes: minutes,
        truncated: false,
        message: `No log groups matching "${args.function_name}". Available: ${logGroups.map((g) => extractFunctionName(g, slug)).join(", ")}`,
      })
    }
  }

  // Query all target log groups in parallel
  const results = await Promise.all(
    targetGroups.map((group) =>
      queryLogGroup(group, slug, startTimeMs, filterPattern, maxPerGroup),
    ),
  )

  const allErrors = results
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const maxTotal = 50
  const truncated = allErrors.length > maxTotal
  const errors = allErrors.slice(0, maxTotal)

  const result: RuntimeErrorsResult = {
    slug,
    errors,
    logGroups: targetGroups,
    timeWindowMinutes: minutes,
    truncated,
  }

  return JSON.stringify(result, null, 2)
}

export function createGetRuntimeErrorsTool(config: DostackConfig) {
  return tool({
    description:
      "Query CloudWatch logs for runtime errors from the deployed workbench backend. " +
      "Returns recent ERROR, Exception, and Traceback entries from the workbench's Lambda functions. " +
      "Use this when the deployed app is misbehaving, returning errors, or when you want to verify a fix worked.",
    args: {
      minutes: tool.schema
        .number()
        .optional()
        .describe(
          "How many minutes back to search. Default: 15. Max recommended: 60.",
        ),
      function_name: tool.schema
        .string()
        .optional()
        .describe(
          "Filter to a specific Lambda function name (partial match). " +
          "Omit to search all functions in the workbench stack.",
        ),
      filter: tool.schema
        .string()
        .optional()
        .describe(
          'Custom CloudWatch filter pattern. Default: \'?ERROR ?Exception ?Traceback ?error\'. ' +
          'Use CloudWatch filter pattern syntax (e.g., \'"KeyError"\' for exact match).',
        ),
    },
    async execute(args) {
      return getRuntimeErrors(config, args)
    },
  })
}
