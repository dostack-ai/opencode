import { describe, test, expect, beforeEach } from "bun:test"
import {
  createAfterResponseHook,
  createTextCompleteHook,
  __resetTextCompleteStateForTests,
} from "../../src/hooks/after-response"

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
  beforeEach(() => {
    __resetTextCompleteStateForTests()
  })

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

describe("textCompleteHook - BUILD_COMPLETE marker + broadened patterns", () => {
  beforeEach(() => {
    __resetTextCompleteStateForTests()
  })

  test("matches deterministic 'BUILD_COMPLETE.' marker on its own line", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Files are generated.\nBUILD_COMPLETE.\n" },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches 'BUILD_COMPLETE' marker without trailing period", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Done.\nBUILD_COMPLETE" },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches lowercase 'build_complete.' marker via /i flag", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "build_complete." },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches 'The build is done' (heuristic)", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "The build is done and the preview is live." },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches 'The project is finished' (heuristic)", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "The project is finished. Nothing else to do." },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches \"I've finished the build\" (heuristic)", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "I've finished the build and everything looks good." },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches 'I have completed all pages' (heuristic)", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "I have completed the work on all pages now." },
    )

    expect(pendingValue).toBe(true)
  })

  test("matches 'all files generated' (heuristic)", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "At this point all files have been generated successfully." },
    )

    expect(pendingValue).toBe(true)
  })

  test("does NOT match 'Hello world.'", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Hello world." },
    )

    expect(pendingValue).toBeUndefined()
  })

  test("does NOT match generic narration without completion phrasing", async () => {
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Now I'll create the migration for the users table." },
    )

    expect(pendingValue).toBeUndefined()
  })
})

describe("textCompleteHook - silence-timeout fallback", () => {
  beforeEach(() => {
    __resetTextCompleteStateForTests()
    delete process.env.BUILDER_SILENCE_TIMEOUT_SEC
  })

  test("fires silence timeout and dispatches completion for short timeout", async () => {
    process.env.BUILDER_SILENCE_TIMEOUT_SEC = "1"
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    // Non-trivial, non-matching text should arm the silence timer.
    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Now I'll create the migration for the users table. Then I'll wire up the UI." },
    )

    expect(pendingValue).toBeUndefined()

    // Wait a bit longer than the 1-second timeout.
    await new Promise((r) => setTimeout(r, 1200))

    expect(pendingValue).toBe(true)

    delete process.env.BUILDER_SILENCE_TIMEOUT_SEC
  })

  test("does NOT arm the silence timer for trivial (<40 char) chunks", async () => {
    process.env.BUILDER_SILENCE_TIMEOUT_SEC = "1"
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Working." }, // too short
    )

    await new Promise((r) => setTimeout(r, 1200))

    expect(pendingValue).toBeUndefined()

    delete process.env.BUILDER_SILENCE_TIMEOUT_SEC
  })

  test("a pattern match clears a previously armed silence timer", async () => {
    process.env.BUILDER_SILENCE_TIMEOUT_SEC = "1"
    let pendingValues: Array<boolean> = []
    const hook = createTextCompleteHook((v) => { pendingValues.push(v) })

    // Arm the silence timer with a non-matching chunk.
    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Now I'll generate the workflow config and check things." },
    )

    // Immediately dispatch via a matching marker — should clear timer.
    await hook(
      { sessionID: "s1", messageID: "m2", partID: "p2" },
      { text: "BUILD_COMPLETE." },
    )

    // Wait past the would-be silence timeout.
    await new Promise((r) => setTimeout(r, 1200))

    // We should see exactly one true (from the marker), not two.
    expect(pendingValues).toEqual([true])

    delete process.env.BUILDER_SILENCE_TIMEOUT_SEC
  })

  test("a later non-matching chunk resets the silence timer", async () => {
    process.env.BUILDER_SILENCE_TIMEOUT_SEC = "1"
    let pendingValue: boolean | undefined
    const hook = createTextCompleteHook((v) => { pendingValue = v })

    // Arm once.
    await hook(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      { text: "Step one: I'll generate the first migration for entities." },
    )

    // Wait half the timeout, then send another non-matching chunk.
    await new Promise((r) => setTimeout(r, 500))
    await hook(
      { sessionID: "s1", messageID: "m2", partID: "p2" },
      { text: "Step two: now I'll wire up the workflows and finish the UI." },
    )

    // After another 700ms, <1s has elapsed since the reset, so no fire yet.
    await new Promise((r) => setTimeout(r, 700))
    expect(pendingValue).toBeUndefined()

    // Wait past the full timeout from the reset.
    await new Promise((r) => setTimeout(r, 500))
    expect(pendingValue).toBe(true)

    delete process.env.BUILDER_SILENCE_TIMEOUT_SEC
  })
})
