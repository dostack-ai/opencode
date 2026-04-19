import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { emitEvent, truncatePayload, createEventEmitter } from "../src/event-emitter"

const opts = {
  coordinatorBase: "https://composer.example.com/api",
  buildJobId: "build-abc",
  authToken: "token-xyz",
}

describe("truncatePayload", () => {
  test("returns payload unchanged when under cap", () => {
    const p = { foo: "bar", n: 42 }
    expect(truncatePayload(p)).toEqual(p)
  })

  test("truncates long string values when over cap", () => {
    const longStr = "x".repeat(5000)
    const out = truncatePayload({ note: longStr })
    expect((out.note as string).length).toBeLessThanOrEqual(256)
    expect((out.note as string).endsWith("...")).toBe(true)
  })

  test("falls back to summary tag when still over cap", () => {
    const payload: Record<string, unknown> = {}
    for (let i = 0; i < 100; i++) {
      payload[`k${i}`] = "y".repeat(100)
    }
    const out = truncatePayload(payload)
    // Either original keys with trimmed values or fallback summary; both must be under cap.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000)
  })
})

describe("emitEvent", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("rejects event_type outside builder.* namespace", async () => {
    await expect(emitEvent(opts, "thinking.delta", {})).rejects.toThrow("builder.")
  })

  test("POSTs to /builds/{id}/events with Bearer auth", async () => {
    let seenUrl = ""
    let seenInit: any = null
    globalThis.fetch = mock(async (url: any, init: any) => {
      seenUrl = String(url)
      seenInit = init
      return new Response("", { status: 200 })
    }) as any

    await emitEvent(opts, "builder.step.progress", { step: "generating", files_written: 3 })

    expect(seenUrl).toBe("https://composer.example.com/api/builds/build-abc/events")
    expect(seenInit.method).toBe("POST")
    expect(seenInit.headers.Authorization).toBe("Bearer token-xyz")
    const body = JSON.parse(seenInit.body)
    expect(body.event_type).toBe("builder.step.progress")
    expect(body.payload.step).toBe("generating")
  })

  test("swallows non-ok responses without throwing", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as any
    // Should not throw
    await emitEvent(opts, "builder.log.error", { message: "x" })
  })

  test("swallows network errors without throwing", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down")
    }) as any
    await emitEvent(opts, "builder.log.error", { message: "x" })
  })
})

describe("createEventEmitter", () => {
  test("binds opts once and exposes emit()", async () => {
    let count = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      count += 1
      return new Response("", { status: 200 })
    }) as any
    try {
      const em = createEventEmitter(opts)
      await em.emit("builder.step.progress", { n: 1 })
      await em.emit("builder.step.completed", { step: "generating" })
      expect(count).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
