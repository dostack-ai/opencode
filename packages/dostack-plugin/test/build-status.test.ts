import { describe, test, expect } from "bun:test"
import { createBuildStatusReporter } from "../src/build-status"
import type { ApiClient } from "../src/api-client"
import type { DostackConfig } from "../src/config"

function mockConfig(): DostackConfig {
  return {
    api_url: "https://api.example.com",
    api_key: "dsk_test1234567890abcdefghij1234567890abcdef",
    workbench_id: "wb-test-001",
  }
}

function mockClient(putFn: (path: string, body?: unknown) => Promise<unknown>): ApiClient {
  return {
    external: {
      get: async () => ({}),
      post: async () => ({}),
      put: putFn,
      delete: async () => ({}),
    },
    internal: {
      get: async () => ({}),
      post: async () => ({}),
      put: async () => ({}),
      delete: async () => ({}),
    },
  } as unknown as ApiClient
}

describe("createBuildStatusReporter", () => {
  test("reportBuilding sends building status to the API", async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const client = mockClient(async (path, body) => {
      calls.push({ path, body })
      return {}
    })

    const { reportBuilding } = createBuildStatusReporter(client, mockConfig())
    reportBuilding()

    // Fire-and-forget — wait for the promise to settle
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe("/composer/workbenches/wb-test-001/build-status")
    expect(calls[0].body).toEqual({ status: "building" })
  })

  test("reportBuilding deduplicates — multiple calls send only one API request", async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const client = mockClient(async (path, body) => {
      calls.push({ path, body })
      return {}
    })

    const { reportBuilding } = createBuildStatusReporter(client, mockConfig())
    reportBuilding()
    reportBuilding()
    reportBuilding()

    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toHaveLength(1)
  })

  test("reportComplete sends complete status to the API", async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const client = mockClient(async (path, body) => {
      calls.push({ path, body })
      return {}
    })

    const { reportComplete } = createBuildStatusReporter(client, mockConfig())
    await reportComplete()

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ status: "complete" })
  })

  test("reportComplete retries once on failure", async () => {
    let callCount = 0
    const client = mockClient(async () => {
      callCount++
      if (callCount === 1) throw new Error("network error")
      return {}
    })

    const { reportComplete } = createBuildStatusReporter(client, mockConfig())
    await reportComplete()

    expect(callCount).toBe(2)
  })

  test("reportComplete survives double failure without throwing", async () => {
    const client = mockClient(async () => {
      throw new Error("network error")
    })

    const { reportComplete } = createBuildStatusReporter(client, mockConfig())
    // Should not throw
    await reportComplete()
  })

  test("resetStatus allows reportBuilding to fire again after complete", async () => {
    const calls: Array<{ body: unknown }> = []
    const client = mockClient(async (_path, body) => {
      calls.push({ body })
      return {}
    })

    const { reportBuilding, reportComplete, resetStatus } = createBuildStatusReporter(client, mockConfig())

    // First cycle
    reportBuilding()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ status: "building" })

    await reportComplete()
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({ status: "complete" })

    // Without reset, reportBuilding won't fire (lastReportedStatus is 'complete', not 'building')
    reportBuilding()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(3) // fires because status changed from complete to building

    // Reset and try again
    resetStatus()
    reportBuilding()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(4)
  })

  test("reportBuilding does not crash when API fails", async () => {
    const client = mockClient(async () => {
      throw new Error("network error")
    })

    const { reportBuilding } = createBuildStatusReporter(client, mockConfig())
    // Should not throw
    reportBuilding()
    await new Promise((r) => setTimeout(r, 10))
  })
})
