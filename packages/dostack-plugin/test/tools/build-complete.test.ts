import { describe, test, expect, mock } from "bun:test"
import { createBuildCompleteTool } from "../../src/tools/build-complete"
import { mkdtemp, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

// Minimal ToolContext-shaped stub — the tool handler only uses the
// first argument (args), so the context can be a skeleton cast.
const ctx = {} as any

function makeFlags() {
  let invoked = false
  return {
    isCompletionInvoked: () => invoked,
    setCompletionInvoked: (v: boolean) => {
      invoked = v
    },
    get value() {
      return invoked
    },
  }
}

describe("createBuildCompleteTool", () => {
  test("empty projectDir rejects with 'no files detected' and does not set flag", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "dostack-bc-empty-"))
    const flags = makeFlags()
    const runBuildComplete = mock(async () => {})

    const t = createBuildCompleteTool({
      projectDir,
      isCompletionInvoked: flags.isCompletionInvoked,
      setCompletionInvoked: flags.setCompletionInvoked,
      runBuildComplete,
    })

    const result = JSON.parse(await t.execute({ summary: "nothing" }, ctx))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no files detected")
    expect(flags.value).toBe(false)
    expect(runBuildComplete).not.toHaveBeenCalled()
  })

  test("non-empty dir + first call returns ok, calls runBuildComplete once, sets flag", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "dostack-bc-ok-"))
    await mkdir(join(projectDir, "frontend/src"), { recursive: true })
    await writeFile(join(projectDir, "frontend/src/App.tsx"), "// app")
    await writeFile(join(projectDir, "README.md"), "# app")

    const flags = makeFlags()
    const runBuildComplete = mock(async () => {})

    const t = createBuildCompleteTool({
      projectDir,
      isCompletionInvoked: flags.isCompletionInvoked,
      setCompletionInvoked: flags.setCompletionInvoked,
      runBuildComplete,
    })

    const result = JSON.parse(
      await t.execute({ summary: "built rfp workbench" }, ctx),
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe("package_uploaded")
    expect(result.summary).toBe("built rfp workbench")
    expect(flags.value).toBe(true)
    expect(runBuildComplete).toHaveBeenCalledTimes(1)
  })

  test("second call after first succeeded returns already-called error, no re-run", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "dostack-bc-idemp-"))
    await writeFile(join(projectDir, "a.ts"), "//")

    const flags = makeFlags()
    const runBuildComplete = mock(async () => {})

    const t = createBuildCompleteTool({
      projectDir,
      isCompletionInvoked: flags.isCompletionInvoked,
      setCompletionInvoked: flags.setCompletionInvoked,
      runBuildComplete,
    })

    const first = JSON.parse(await t.execute({ summary: "first" }, ctx))
    expect(first.ok).toBe(true)
    expect(runBuildComplete).toHaveBeenCalledTimes(1)

    const second = JSON.parse(await t.execute({ summary: "second" }, ctx))
    expect(second.ok).toBe(false)
    expect(second.error).toContain("already called")
    expect(runBuildComplete).toHaveBeenCalledTimes(1)
  })

  test("runBuildComplete rejects — tool returns ok:false and flag stays set (blocks retry)", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "dostack-bc-fail-"))
    await writeFile(join(projectDir, "a.ts"), "//")

    const flags = makeFlags()
    const runBuildComplete = mock(async () => {
      throw new Error("assembleAndUploadPackage blew up")
    })

    const t = createBuildCompleteTool({
      projectDir,
      isCompletionInvoked: flags.isCompletionInvoked,
      setCompletionInvoked: flags.setCompletionInvoked,
      runBuildComplete,
    })

    const result = JSON.parse(await t.execute({ summary: "crashy" }, ctx))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("buildComplete failed")
    expect(result.error).toContain("assembleAndUploadPackage blew up")
    expect(flags.value).toBe(true)
    expect(runBuildComplete).toHaveBeenCalledTimes(1)

    // A second call must still be blocked — no retry path.
    const retry = JSON.parse(await t.execute({ summary: "retry" }, ctx))
    expect(retry.ok).toBe(false)
    expect(retry.error).toContain("already called")
    expect(runBuildComplete).toHaveBeenCalledTimes(1)
  })

  test("dotfile-only project is treated as empty", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "dostack-bc-dot-"))
    await writeFile(join(projectDir, ".dostack"), "")
    await writeFile(join(projectDir, ".env"), "")

    const flags = makeFlags()
    const runBuildComplete = mock(async () => {})

    const t = createBuildCompleteTool({
      projectDir,
      isCompletionInvoked: flags.isCompletionInvoked,
      setCompletionInvoked: flags.setCompletionInvoked,
      runBuildComplete,
    })

    const result = JSON.parse(await t.execute({ summary: "empty" }, ctx))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no files detected")
    expect(runBuildComplete).not.toHaveBeenCalled()
    expect(flags.value).toBe(false)
  })
})
