import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  walkFiles,
  checksumBundle,
  inferContentType,
  postComplete,
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
