import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createApiClient, ApiClientError } from "../src/api-client"
import type { DostackConfig } from "../src/config"

const baseConfig: DostackConfig = {
  api_url: "https://api.dostack.ai",
  api_key: "dsk_test_key_123",
  workbench_id: "wb_abc123",
}

const configWithInternal: DostackConfig = {
  ...baseConfig,
  internal_api_url: "https://internal.dostack.ai",
  internal_api_token: "tok_secret",
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(status: number, body: unknown): void {
  const responseText = JSON.stringify(body)
  globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(responseText, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
}

describe("createApiClient", () => {
  test("external GET sends X-Api-Key header", async () => {
    let capturedInit: RequestInit | undefined
    let capturedUrl: string | undefined

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedInit = init
      return new Response("{}", { status: 200 })
    }

    const client = createApiClient(baseConfig)
    await client.external.get("/workflows")

    expect(capturedUrl).toBe("https://api.dostack.ai/workflows")
    expect((capturedInit?.headers as Record<string, string>)["X-Api-Key"]).toBe("dsk_test_key_123")
  })

  test("external POST sends body as JSON", async () => {
    let capturedInit: RequestInit | undefined

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response("{}", { status: 200 })
    }

    const client = createApiClient(baseConfig)
    await client.external.post("/workflows", { name: "my workflow" })

    expect(capturedInit?.method).toBe("POST")
    expect(capturedInit?.body).toBe(JSON.stringify({ name: "my workflow" }))
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
  })

  test("throws ApiClientError on non-2xx response", async () => {
    mockFetch(404, { error: "not_found", details: { id: "abc" } })

    const client = createApiClient(baseConfig)

    let caught: unknown
    try {
      await client.external.get("/workflows/abc")
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ApiClientError)
    const err = caught as ApiClientError
    expect(err.status).toBe(404)
    expect(err.code).toBe("not_found")
    expect(err.details).toEqual({ id: "abc" })
  })

  test("internal GET sends Authorization header when token configured", async () => {
    let capturedInit: RequestInit | undefined
    let capturedUrl: string | undefined

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString()
      capturedInit = init
      return new Response("{}", { status: 200 })
    }

    const client = createApiClient(configWithInternal)
    await client.internal.get("/internal/data")

    expect(capturedUrl).toBe("https://internal.dostack.ai/internal/data")
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok_secret")
  })

  test("internal calls throw when not configured", async () => {
    const client = createApiClient(baseConfig) // no internal_api_url

    expect(() => client.internal.get("/anything")).toThrow("dostack-plugin")
    expect(() => client.internal.get("/anything")).toThrow("internal API")
  })
})
