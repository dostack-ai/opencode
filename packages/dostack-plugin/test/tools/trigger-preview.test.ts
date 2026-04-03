import { describe, test, expect } from "bun:test"
import { triggerPreview } from "../../src/tools/trigger-preview"
import { mkdtemp, writeFile, readFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

async function setupProjectWithPackageJson(dir: string) {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-workbench", scripts: { build: "echo BUILD_OK" } }))
  await mkdir(join(dir, ".dostack"), { recursive: true })
}

describe("triggerPreview", () => {
  test("runs build and writes preview-ready signal on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-preview-"))
    await setupProjectWithPackageJson(dir)

    const result = JSON.parse(await triggerPreview(dir, {}))

    expect(result.success).toBe(true)
    expect(result.buildTimeMs).toBeGreaterThanOrEqual(0)

    const signal = await readFile(join(dir, ".dostack/preview-ready"), "utf-8")
    expect(signal).toBeTruthy()
  })

  test("returns errors on build failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-preview-"))
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "exit 1" } }))
    await mkdir(join(dir, ".dostack"), { recursive: true })

    const result = JSON.parse(await triggerPreview(dir, {}))

    expect(result.success).toBe(false)
  })

  test("check_only runs tsc instead of full build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-preview-"))
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test", scripts: { typecheck: "echo TYPECHECK_OK" } }))
    await mkdir(join(dir, ".dostack"), { recursive: true })

    const result = JSON.parse(await triggerPreview(dir, { check_only: true }))

    expect(result.success).toBe(true)
  })
})
