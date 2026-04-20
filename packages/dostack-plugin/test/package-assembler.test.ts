import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  walkFiles,
  checksumBundle,
  inferContentType,
  postComplete,
  fetchPresignedUrls,
  putToPresignedUrl,
  assembleAndUploadPackage,
} from "../src/package-assembler"

describe("walkFiles", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pkg-assembler-"))
    await writeFile(join(dir, "index.html"), "<html>")
    await mkdir(join(dir, "assets"))
    await writeFile(join(dir, "assets", "app.js"), "console.log(1)")
    await writeFile(join(dir, "assets", "app.css"), ".a{}")
    await mkdir(join(dir, "assets", "nested"))
    await writeFile(join(dir, "assets", "nested", "deep.svg"), "<svg/>")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("walks a directory recursively with posix-style relative paths", async () => {
    const files = (await walkFiles(dir)).sort()
    expect(files).toEqual([
      "assets/app.css",
      "assets/app.js",
      "assets/nested/deep.svg",
      "index.html",
    ])
  })
})

describe("checksumBundle", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pkg-checksum-"))
    await writeFile(join(dir, "a.txt"), "hello")
    await writeFile(join(dir, "b.txt"), "world")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("is deterministic and stable for the same file set", async () => {
    const files = ["a.txt", "b.txt"]
    const h1 = await checksumBundle(dir, files)
    const h2 = await checksumBundle(dir, files)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  test("changes when file contents change", async () => {
    const files = ["a.txt", "b.txt"]
    const before = await checksumBundle(dir, files)
    await writeFile(join(dir, "b.txt"), "worldX")
    const after = await checksumBundle(dir, files)
    expect(before).not.toBe(after)
  })

  test("does not depend on input-array ordering", async () => {
    const asc = await checksumBundle(dir, ["a.txt", "b.txt"])
    const desc = await checksumBundle(dir, ["b.txt", "a.txt"])
    expect(asc).toBe(desc)
  })
})

describe("inferContentType", () => {
  test.each([
    ["index.html", "text/html; charset=utf-8"],
    ["app.js", "application/javascript; charset=utf-8"],
    ["module.mjs", "application/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["config.json", "application/json"],
    ["app.js.map", "application/json"],
    ["icon.svg", "image/svg+xml"],
    ["logo.png", "image/png"],
    ["favicon.ico", "image/x-icon"],
    ["font.woff2", "font/woff2"],
    ["blob.bin", "application/octet-stream"],
  ])("infers %s -> %s", (name, expected) => {
    expect(inferContentType(name)).toBe(expected)
  })
})

describe("fetchPresignedUrls", () => {
  test("POSTs to /builds/{id}/presign-upload with bearer auth + files[] + flags", async () => {
    const originalFetch = globalThis.fetch
    let seenUrl = ""
    let seenInit: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(
        JSON.stringify({
          bundle_urls: { "index.html": "https://s3.example/put?sig=a" },
          manifest_url: "https://s3.example/manifest?sig=m",
          spec_url: "https://s3.example/spec?sig=s",
          expiry_iso: "2026-04-20T14:30:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as any
    try {
      const body = await fetchPresignedUrls({
        coordinatorBase: "https://composer.example.com/",
        buildJobId: "job-1",
        authToken: "tok-xyz",
        files: [{ rel_path: "index.html", content_type: "text/html; charset=utf-8" }],
        wantManifest: true,
        wantSpec: true,
      })
      expect(seenUrl).toBe("https://composer.example.com/builds/job-1/presign-upload")
      expect(seenInit.method).toBe("POST")
      expect(seenInit.headers.Authorization).toBe("Bearer tok-xyz")
      const sent = JSON.parse(seenInit.body)
      expect(sent.files).toEqual([
        { rel_path: "index.html", content_type: "text/html; charset=utf-8" },
      ])
      expect(sent.manifest).toBe(true)
      expect(sent.spec).toBe(true)
      expect(body.bundle_urls["index.html"]).toBe("https://s3.example/put?sig=a")
      expect(body.manifest_url).toBe("https://s3.example/manifest?sig=m")
      expect(body.spec_url).toBe("https://s3.example/spec?sig=s")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws with coordinator status + body on non-2xx", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any
    try {
      await expect(
        fetchPresignedUrls({
          coordinatorBase: "https://composer.example.com",
          buildJobId: "job-1",
          authToken: "wrong",
          files: [{ rel_path: "x", content_type: "text/plain" }],
        }),
      ).rejects.toThrow("/presign-upload failed: 401")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws when response body has no bundle_urls", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 })) as any
    try {
      await expect(
        fetchPresignedUrls({
          coordinatorBase: "https://composer.example.com",
          buildJobId: "job-1",
          authToken: "tok",
          files: [],
        }),
      ).rejects.toThrow("missing bundle_urls")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("putToPresignedUrl", () => {
  test("PUTs body with Content-Type header to the given URL", async () => {
    const originalFetch = globalThis.fetch
    let seenUrl = ""
    let seenInit: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenInit = init
      return new Response("", { status: 200 })
    }) as any
    try {
      await putToPresignedUrl(
        "https://s3.example/pkg/index.html?sig=abc",
        Buffer.from("<html>"),
        "text/html; charset=utf-8",
        "index.html",
      )
      expect(seenUrl).toBe("https://s3.example/pkg/index.html?sig=abc")
      expect(seenInit.method).toBe("PUT")
      expect(seenInit.headers["Content-Type"]).toBe("text/html; charset=utf-8")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws on non-ok S3 PUT response", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("SignatureDoesNotMatch", { status: 403 })) as any
    try {
      await expect(
        putToPresignedUrl(
          "https://s3.example/put?sig=bad",
          "body",
          "application/json",
          "manifest.json",
        ),
      ).rejects.toThrow("presigned PUT for manifest.json failed: 403")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("assembleAndUploadPackage", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pkg-e2e-"))
    await writeFile(join(dir, "index.html"), "<html>")
    await mkdir(join(dir, "assets"))
    await writeFile(join(dir, "assets", "app.js"), "console.log(1)")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("end-to-end: presign -> PUT each file + manifest + spec; manifest shape is correct", async () => {
    const originalFetch = globalThis.fetch
    const seenPuts: Array<{ url: string; ct: string; bodyPreview: string }> = []
    let presignSeenBody: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.endsWith("/presign-upload")) {
        presignSeenBody = JSON.parse(init.body)
        return new Response(
          JSON.stringify({
            bundle_urls: {
              "index.html": "https://s3.example/bundle/index.html?sig=1",
              "assets/app.js": "https://s3.example/bundle/assets/app.js?sig=2",
            },
            manifest_url: "https://s3.example/manifest.json?sig=m",
            spec_url: "https://s3.example/spec.json?sig=s",
            expiry_iso: "2026-04-20T14:30:00Z",
          }),
          { status: 200 },
        )
      }
      // PUT path
      const body = init.body
      const preview =
        typeof body === "string"
          ? body.slice(0, 64)
          : Buffer.isBuffer(body)
          ? body.toString("utf-8").slice(0, 64)
          : String(body).slice(0, 64)
      seenPuts.push({
        url: u,
        ct: init.headers["Content-Type"],
        bodyPreview: preview,
      })
      return new Response("", { status: 200 })
    }) as any
    try {
      const out = await assembleAndUploadPackage({
        workbenchId: "wb-abc",
        specVersion: 7,
        bundleDir: dir,
        packageS3Bucket: "test-packages",
        packageVersion: "pkg-fixed",
        spec: { entities: [], actions: [] },
        coordinatorBase: "https://composer.example.com",
        buildJobId: "job-abc",
        authToken: "builder-tok",
      })
      expect(out.packageVersion).toBe("pkg-fixed")
      expect(out.s3Prefix).toBe("s3://test-packages/wb-abc/pkg-fixed/")
      expect(out.fileCount).toBe(2)
      expect(out.manifest.workbench_id).toBe("wb-abc")
      expect(out.manifest.spec_version).toBe(7)
      expect((out.manifest.checksums as any).frontend_bundle).toMatch(/^sha256:[0-9a-f]{64}$/)

      // Coordinator was asked for exactly these files + manifest + spec.
      expect(presignSeenBody.files).toEqual(
        expect.arrayContaining([
          { rel_path: "index.html", content_type: "text/html; charset=utf-8" },
          { rel_path: "assets/app.js", content_type: "application/javascript; charset=utf-8" },
        ]),
      )
      expect(presignSeenBody.manifest).toBe(true)
      expect(presignSeenBody.spec).toBe(true)

      // Four PUTs total: 2 bundle files + manifest + spec.
      expect(seenPuts).toHaveLength(4)
      const urls = seenPuts.map((p) => p.url)
      expect(urls).toEqual(
        expect.arrayContaining([
          "https://s3.example/bundle/index.html?sig=1",
          "https://s3.example/bundle/assets/app.js?sig=2",
          "https://s3.example/manifest.json?sig=m",
          "https://s3.example/spec.json?sig=s",
        ]),
      )
      // Manifest PUT carries application/json.
      const manifestPut = seenPuts.find(
        (p) => p.url === "https://s3.example/manifest.json?sig=m",
      )!
      expect(manifestPut.ct).toBe("application/json")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws if coordinator returns no URL for a bundle file", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith("/presign-upload")) {
        return new Response(
          JSON.stringify({
            // Deliberately missing "assets/app.js".
            bundle_urls: { "index.html": "https://s3.example/index.html?sig=1" },
            manifest_url: "https://s3.example/manifest.json?sig=m",
            spec_url: "https://s3.example/spec.json?sig=s",
            expiry_iso: "2026-04-20T14:30:00Z",
          }),
          { status: 200 },
        )
      }
      return new Response("", { status: 200 })
    }) as any
    try {
      await expect(
        assembleAndUploadPackage({
          workbenchId: "wb",
          specVersion: 1,
          bundleDir: dir,
          packageS3Bucket: "test",
          spec: {},
          coordinatorBase: "https://composer.example.com",
          buildJobId: "job",
          authToken: "tok",
        }),
      ).rejects.toThrow("did not mint a presigned URL for assets/app.js")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("postComplete", () => {
  test("POSTs to /builds/{id}/complete with bearer auth + package_s3_prefix", async () => {
    const originalFetch = globalThis.fetch
    let seenUrl = ""
    let seenInit: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenInit = init
      return new Response("", { status: 204 })
    }) as any
    try {
      await postComplete(
        "https://composer.example.com/api",
        "job-123",
        "tok-abc",
        "s3://bucket/wb/pkg/",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(seenUrl).toBe("https://composer.example.com/api/builds/job-123/complete")
    expect(seenInit.method).toBe("POST")
    expect(seenInit.headers.Authorization).toBe("Bearer tok-abc")
    const body = JSON.parse(seenInit.body)
    expect(body.package_s3_prefix).toBe("s3://bucket/wb/pkg/")
  })

  test("throws on non-ok response", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("bad", { status: 500 })) as any
    try {
      await expect(
        postComplete("https://composer.example.com/api", "job-1", "tok", "s3://a/b/"),
      ).rejects.toThrow("/complete failed")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
