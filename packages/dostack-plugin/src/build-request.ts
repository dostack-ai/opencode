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
 * Fetch the build request JSON from S3 (uses the container's IAM role —
 * no credentials in code). Falls back to plain HTTPS fetch when the URI
 * is an https:// URL, which is useful for tests and local dev.
 */
export async function loadBuildRequest(s3Uri: string): Promise<BuildRequest> {
  if (!s3Uri) throw new Error("BUILD_REQUEST_S3_URI is empty")

  let body: string
  if (s3Uri.startsWith("s3://")) {
    body = await fetchFromS3(s3Uri)
  } else if (s3Uri.startsWith("https://")) {
    const res = await fetch(s3Uri)
    if (!res.ok) throw new Error(`build request fetch failed: ${res.status}`)
    body = await res.text()
  } else {
    throw new Error(`unsupported BUILD_REQUEST_S3_URI scheme: ${s3Uri}`)
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

async function fetchFromS3(s3Uri: string): Promise<string> {
  // Lazy import so plugin can load without aws-sdk in environments that don't need it.
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3")
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
  if (!match) throw new Error(`malformed s3:// URI: ${s3Uri}`)
  const [, bucket, key] = match
  const region = process.env.AWS_REGION || "us-east-1"
  const client = new S3Client({ region })
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!resp.Body) throw new Error("s3 response body missing")
  // @ts-ignore — Node.js stream → string
  return await resp.Body.transformToString()
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
