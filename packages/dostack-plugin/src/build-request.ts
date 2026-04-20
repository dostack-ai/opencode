/**
 * Build request loader.
 *
 * The dostack coordinator uploads a JSON file to S3 at
 * ${PACKAGE_S3_BUCKET}/${workbench_id}/${package_version}/build_request.json
 * before starting the Fargate task, and passes the S3 URI via the
 * BUILD_REQUEST_S3_URI env var. This module loads + validates that JSON
 * at plugin startup and exposes it to the before-prompt hook so Claude
 * sees the structured spec + workflow bindings rather than inferring
 * them from chat history.
 */

export interface BuildRequest {
  spec: {
    spec_version: number
    identity: { name: string; slug: string; description: string }
    entities: Array<Record<string, unknown>>
    roles: Array<Record<string, unknown>>
    actions: Array<Record<string, unknown>>
    ui_intent: Record<string, unknown>
  }
  workflow_bindings: Array<{
    workflow_id: string
    version_id: string
    name: string
    steps: Array<Record<string, unknown>>
    input_schema: Record<string, unknown>
    result_contract: Record<string, unknown>
    interaction_contract: Record<string, unknown>
  }>
  template_version: string
  build_job_id: string
  workbench_id: string
}

/**
 * Load the build request JSON.
 *
 * The entrypoint script pre-downloads the build_request.json to disk
 * and exports BUILD_REQUEST_LOCAL_PATH because @aws-sdk/client-s3 does
 * not load inside Bun's plugin-load context — bare-specifier, absolute-
 * path, and static-top-level imports all resolve to an empty namespace.
 * An https:// URI is also accepted for local/test runs where the JSON
 * is exposed via a presigned URL.
 */
export async function loadBuildRequest(s3Uri: string): Promise<BuildRequest> {
  const localPath = process.env.BUILD_REQUEST_LOCAL_PATH
  let body: string
  if (localPath) {
    const { readFile } = await import("node:fs/promises")
    body = await readFile(localPath, "utf-8")
  } else if (s3Uri && s3Uri.startsWith("https://")) {
    const res = await fetch(s3Uri)
    if (!res.ok) throw new Error(`build request fetch failed: ${res.status}`)
    body = await res.text()
  } else {
    throw new Error(
      "build request not available: BUILD_REQUEST_LOCAL_PATH must be set " +
        "by the entrypoint, or BUILD_REQUEST_S3_URI must be an https:// URL",
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new Error(`build request JSON parse failed: ${e}`)
  }
  validateBuildRequest(parsed)
  return parsed as BuildRequest
}
export function validateBuildRequest(obj: unknown): asserts obj is BuildRequest {
  const o = obj as Record<string, unknown>
  if (!o || typeof o !== "object") throw new Error("build request must be an object")
  if (!o.spec || typeof o.spec !== "object") throw new Error("build request missing spec")
  if (!Array.isArray(o.workflow_bindings))
    throw new Error("build request missing workflow_bindings[]")
  if (typeof o.build_job_id !== "string") throw new Error("build request missing build_job_id")
  if (typeof o.workbench_id !== "string") throw new Error("build request missing workbench_id")
}
