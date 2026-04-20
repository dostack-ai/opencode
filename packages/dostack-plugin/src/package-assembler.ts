/**
 * Package assembler.
 *
 * When the build completes, walks the generated frontend bundle
 * directory, computes SHA-256 checksums, assembles the manifest.json
 * per the workbench-package RFC, uploads manifest + bundle to S3, and
 * triggers the coordinator's /complete callback.
 */
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

export interface PackageAssemblyOpts {
  workbenchId: string
  specVersion: number
  bundleDir: string // local path to built bundle (e.g. /workspace/template/frontend/dist)
  packageS3Bucket: string
  packageVersion?: string // auto-generated if not provided
  spec: Record<string, unknown>
}

export interface AssembledPackage {
  packageVersion: string
  s3Prefix: string // s3://bucket/workbench_id/package_version/
  manifest: Record<string, unknown>
  fileCount: number
}

export async function assembleAndUploadPackage(
  opts: PackageAssemblyOpts,
): Promise<AssembledPackage> {
  const packageVersion = opts.packageVersion ?? `pkg-${Date.now().toString(36)}`
  const s3Prefix = `s3://${opts.packageS3Bucket}/${opts.workbenchId}/${packageVersion}/`

  const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" })

  // 1. Walk bundle dir, compute file list + checksum
  const files = await walkFiles(opts.bundleDir)
  const bundleChecksum = await checksumBundle(opts.bundleDir, files)

  // 2. Upload every file in the bundle to s3://bucket/wb/pkg/bundle/<rel_path>
  for (const rel of files) {
    const abs = join(opts.bundleDir, rel)
    const body = await readFile(abs)
    await s3.send(
      new PutObjectCommand({
        Bucket: opts.packageS3Bucket,
        Key: `${opts.workbenchId}/${packageVersion}/bundle/${rel}`,
        Body: body,
        ContentType: inferContentType(rel),
      }),
    )
  }

  // 3. Upload spec.json
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.packageS3Bucket,
      Key: `${opts.workbenchId}/${packageVersion}/spec.json`,
      Body: JSON.stringify(opts.spec, null, 2),
      ContentType: "application/json",
    }),
  )

  // 4. Build + upload manifest
  const manifest = {
    package_version: packageVersion,
    workbench_id: opts.workbenchId,
    spec_version: opts.specVersion,
    frontend_bundle_ref: `${s3Prefix}bundle/`,
    checksums: { frontend_bundle: `sha256:${bundleChecksum}` },
    file_count: files.length,
    created_at: new Date().toISOString(),
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.packageS3Bucket,
      Key: `${opts.workbenchId}/${packageVersion}/manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    }),
  )

  return { packageVersion, s3Prefix, manifest, fileCount: files.length }
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
