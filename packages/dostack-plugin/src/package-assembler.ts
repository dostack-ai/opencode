/**
 * Package assembler.
 *
 * When the build completes, walks the generated frontend bundle
 * directory, computes SHA-256 checksums, assembles the manifest.json
 * per the workbench-package RFC, and uploads manifest + bundle + spec
 * via presigned PUT URLs minted by the coordinator.
 *
 * Phase 1e Option B: the upload path no longer uses @aws-sdk/client-s3.
 * Bun's plugin-load context returns an empty namespace for the SDK
 * module (confirmed for dynamic bare-specifier, absolute-path, and
 * static top-level forms), so `new S3Client(...)` blows up with
 * "undefined is not a constructor". Instead, the plugin POSTs a list
 * of {rel_path, content_type} to the coordinator's /presign-upload
 * route, gets back presigned https PUT URLs, and uploads via plain
 * fetch(). Zero AWS SDK usage in this module.
 *
 * Read path (build-request.ts) is unchanged — entrypoint.sh's
 * BUILD_REQUEST_LOCAL_PATH prefetch is still the primary; see that
 * file for the dead-code fallback note.
 */
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

export interface PackageAssemblyOpts {
  workbenchId: string
  specVersion: number
  bundleDir: string // local path to built bundle (e.g. /workspace/template/frontend/dist)
  packageS3Bucket: string
  packageVersion?: string // auto-generated if not provided
  spec: Record<string, unknown>
  coordinatorBase: string // e.g. https://composer.example.com — used for /builds/{id}/presign-upload
  buildJobId: string
  authToken: string // builder auth token; same token used by /complete + /events
}

export interface AssembledPackage {
  packageVersion: string
  s3Prefix: string // s3://bucket/workbench_id/package_version/
  manifest: Record<string, unknown>
  fileCount: number
}

interface PresignResponse {
  bundle_urls: Record<string, string>
  manifest_url?: string
  spec_url?: string
  expiry_iso: string
}

export async function assembleAndUploadPackage(
  opts: PackageAssemblyOpts,
): Promise<AssembledPackage> {
  const packageVersion = opts.packageVersion ?? `pkg-${Date.now().toString(36)}`
  const s3Prefix = `s3://${opts.packageS3Bucket}/${opts.workbenchId}/${packageVersion}/`

  // 1. Walk bundle dir, compute file list + checksum.
  const files = await walkFiles(opts.bundleDir)
  const bundleChecksum = await checksumBundle(opts.bundleDir, files)

  // 2. Ask the coordinator for presigned PUT URLs — one per bundle file,
  //    plus manifest_url + spec_url. 30-min TTL; minted on demand so the
  //    build loop itself doesn't have to carry AWS credentials.
  const presign = await fetchPresignedUrls({
    coordinatorBase: opts.coordinatorBase,
    buildJobId: opts.buildJobId,
    authToken: opts.authToken,
    files: files.map((rel) => ({
      rel_path: rel,
      content_type: inferContentType(rel),
    })),
    wantManifest: true,
    wantSpec: true,
  })

  // 3. PUT every bundle file to its presigned URL via plain fetch().
  for (const rel of files) {
    const url = presign.bundle_urls[rel]
    if (!url) {
      throw new Error(`coordinator did not mint a presigned URL for ${rel}`)
    }
    const abs = join(opts.bundleDir, rel)
    const body = await readFile(abs)
    await putToPresignedUrl(url, body, inferContentType(rel), rel)
  }

  // 4. PUT spec.json.
  if (!presign.spec_url) {
    throw new Error("coordinator did not mint a spec_url; cannot upload spec.json")
  }
  await putToPresignedUrl(
    presign.spec_url,
    JSON.stringify(opts.spec, null, 2),
    "application/json",
    "spec.json",
  )

  // 5. Build + PUT manifest.json.
  const manifest = {
    package_version: packageVersion,
    workbench_id: opts.workbenchId,
    spec_version: opts.specVersion,
    frontend_bundle_ref: `${s3Prefix}bundle/`,
    checksums: { frontend_bundle: `sha256:${bundleChecksum}` },
    file_count: files.length,
    created_at: new Date().toISOString(),
  }
  if (!presign.manifest_url) {
    throw new Error("coordinator did not mint a manifest_url; cannot upload manifest.json")
  }
  await putToPresignedUrl(
    presign.manifest_url,
    JSON.stringify(manifest, null, 2),
    "application/json",
    "manifest.json",
  )

  return { packageVersion, s3Prefix, manifest, fileCount: files.length }
}

/**
 * POST /builds/{job_id}/presign-upload on the coordinator HTTP API.
 *
 * Returns the full response body on success; throws on non-2xx. The
 * coordinator route is Auth: NONE at the API Gateway layer and does its
 * own Bearer-token check against the BuildJob row's builder_auth_token.
 */
export async function fetchPresignedUrls(args: {
  coordinatorBase: string
  buildJobId: string
  authToken: string
  files: Array<{ rel_path: string; content_type: string }>
  wantManifest?: boolean
  wantSpec?: boolean
}): Promise<PresignResponse> {
  const url = `${args.coordinatorBase.replace(/\/$/, "")}/builds/${args.buildJobId}/presign-upload`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: args.files,
      manifest: args.wantManifest ?? false,
      spec: args.wantSpec ?? false,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`coordinator /presign-upload failed: ${res.status} ${text}`)
  }
  const body = (await res.json()) as PresignResponse
  if (!body || typeof body !== "object" || !body.bundle_urls) {
    throw new Error("coordinator /presign-upload response missing bundle_urls")
  }
  return body
}

/**
 * PUT a body to a presigned URL. The URL already carries the SigV4 (or
 * legacy presign) signature that S3 requires; the caller just needs the
 * right Content-Type (which must match what the coordinator passed into
 * generate_presigned_url, because S3 includes Content-Type in the
 * signed request).
 */
export async function putToPresignedUrl(
  url: string,
  body: Buffer | string,
  contentType: string,
  labelForError: string,
): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: body as any,
    headers: { "Content-Type": contentType },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>")
    throw new Error(
      `presigned PUT for ${labelForError} failed: ${res.status} ${text}`,
    )
  }
}

export async function walkFiles(root: string, sub: string = ""): Promise<string[]> {
  const out: string[] = []
  const here = join(root, sub)
  const entries = await readdir(here, { withFileTypes: true })
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walkFiles(root, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

export async function checksumBundle(root: string, files: string[]): Promise<string> {
  const hash = createHash("sha256")
  // Sort for determinism
  const sorted = [...files].sort()
  for (const rel of sorted) {
    hash.update(rel)
    hash.update("\0")
    const body = await readFile(join(root, rel))
    hash.update(body)
  }
  return hash.digest("hex")
}

export function inferContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8"
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8"
  if (path.endsWith(".mjs")) return "application/javascript; charset=utf-8"
  if (path.endsWith(".css")) return "text/css; charset=utf-8"
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".map")) return "application/json"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".ico")) return "image/x-icon"
  if (path.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

export async function postComplete(
  coordinatorBase: string,
  buildJobId: string,
  authToken: string,
  packageS3Prefix: string,
): Promise<void> {
  const url = `${coordinatorBase.replace(/\/$/, "")}/builds/${buildJobId}/complete`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ package_s3_prefix: packageS3Prefix }),
  })
  if (!res.ok) {
    throw new Error(`coordinator /complete failed: ${res.status} ${await res.text()}`)
  }
}
