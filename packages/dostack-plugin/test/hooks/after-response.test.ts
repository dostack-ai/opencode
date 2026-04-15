import { describe, test, expect } from "bun:test"
import { createAfterResponseHook } from "../../src/hooks/after-response"

describe("afterResponseHook", () => {
  test("sets verification pending when response contains build complete", async () => {
    let pendingValue: boolean | undefined
    const setVerification = (v: boolean) => { pendingValue = v }
    const invalidateCache = () => {}

    const hook = createAfterResponseHook("/tmp/fake", invalidateCache, setVerification)

    await hook(
      { tool: "write", sessionID: "s1", callID: "c1", args: {}, response: "The build complete and ready to deploy." },
      { title: "", output: "", metadata: {} },
    )

    expect(pendingValue).toBe(true)
  })

  test("sets verification pending when response contains all tasks done", async () => {
    let pendingValue: boolean | undefined
    const setVerification = (v: boolean) => { pendingValue = v }
    const invalidateCache = () => {}

    const hook = createAfterResponseHook("/tmp/fake", invalidateCache, setVerification)

    await hook(
      { tool: "write", sessionID: "s1", callID: "c1", args: {}, response: "All tasks done. The app is ready." },
      { title: "", output: "", metadata: {} },
    )

    expect(pendingValue).toBe(true)
  })

  test("does not set verification pending for normal responses", async () => {
    let pendingValue: boolean | undefined
    const setVerification = (v: boolean) => { pendingValue = v }
    const invalidateCache = () => {}

    const hook = createAfterResponseHook("/tmp/fake", invalidateCache, setVerification)

    await hook(
      { tool: "write", sessionID: "s1", callID: "c1", args: {}, response: "I have updated the migration file." },
      { title: "", output: "", metadata: {} },
    )

    expect(pendingValue).toBeUndefined()
  })

  test("still invalidates cache on file write tools", async () => {
    let cacheInvalidated = false
    const invalidateCache = () => { cacheInvalidated = true }
    const setVerification = () => {}

    const hook = createAfterResponseHook("/tmp/fake", invalidateCache, setVerification)

    await hook(
      { tool: "write", sessionID: "s1", callID: "c1", args: {}, response: "Done." },
      { title: "", output: "", metadata: {} },
    )

    expect(cacheInvalidated).toBe(true)
  })
})
