import { describe, test, expect } from "bun:test"
import { createAfterResponseHook, createTextCompleteHook } from "../../src/hooks/after-response"

describe("afterResponseHook", () => {
  test("invalidates cache on file write tools", async () => {
    let cacheInvalidated = false
    const hook = createAfterResponseHook("/tmp/fake", () => { cacheInvalidated = true })

    await hook(
      { tool: "write", sessionID: "s1", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(cacheInvalidated).toBe(true)
  })

  test("does not invalidate cache for non-write tools", async () => {
    let cacheInvalidated = false
    const hook = createAfterResponseHook("/tmp/fake", () => { cacheInvalidated = true })

    await hook(
      { tool: "dostack_query_workflows", sessionID: "s1", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(cacheInvalidated).toBe(false)
  })

  test("calls reportBuilding on file write", async () => {
    let buildingReported = false
    const hook = createAfterResponseHook("/tmp/fake", () => {}, () => { buildingReported = true })

    await hook(
      { tool: "edit", sessionID: "s1", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(buildingReported).toBe(true)
  })

  test("does not call reportBuilding for non-write tools", async () => {
    let buildingReported = false
    const hook = createAfterResponseHook("/tmp/fake", () => {}, () => { buildingReported = true })

    await hook(
      { tool: "dostack_query_workflows", sessionID: "s1", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(buildingReported).toBe(false)
  })
})

describe("textCompleteHook - build complete detection", () => {
  test("sets verification pending when text contains 'build complete'", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "The build is now complete. All files are in place." },
    )

    expect(pendingValue).toBe(true)
  })

  test("sets verification pending for 'Build passes cleanly'", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Build passes cleanly with no errors." },
    )

    expect(pendingValue).toBe(true)
  })

  test("sets verification pending for 'all tasks done'", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "All tasks done. The app is ready." },
    )

    expect(pendingValue).toBe(true)
  })

  test("sets verification pending for 'ready to deploy'", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "The workbench is ready to deploy." },
    )

    expect(pendingValue).toBe(true)
  })

  test("does not trigger for normal response text", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "I've updated the migration file and added the new column." },
    )

    expect(pendingValue).toBeUndefined()
  })

  test("does not trigger for partial matches in different context", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "I still need to complete the build configuration." },
    )

    // "complete" and "build" are present but not as "build complete"
    expect(pendingValue).toBeUndefined()
  })

  test("calls reportComplete instead of setVerificationPending when verification is complete", async () => {
    let pendingValue: boolean | undefined
    let completeCalled = false
    const hook = createTextCompleteHook(
      (v) => { pendingValue = v },
      {
        isVerificationComplete: () => true,
        reportComplete: async () => { completeCalled = true },
      },
    )

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Build is now complete." },
    )

    expect(completeCalled).toBe(true)
    expect(pendingValue).toBeUndefined() // should NOT set pending
  })

  test("sets verification pending when verification is not yet complete", async () => {
    let pendingValue: boolean | undefined
    let completeCalled = false
    const hook = createTextCompleteHook(
      (v) => { pendingValue = v },
      {
        isVerificationComplete: () => false,
        reportComplete: async () => { completeCalled = true },
      },
    )

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Build is now complete." },
    )

    expect(pendingValue).toBe(true)
    expect(completeCalled).toBe(false)
  })
})
