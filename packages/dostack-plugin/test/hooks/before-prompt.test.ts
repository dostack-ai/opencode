import { describe, test, expect } from "bun:test"
import { createBeforePromptHook } from "../../src/hooks/before-prompt"
import { mkdtemp, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import type { ApiClient } from "../../src/api-client"

describe("beforePromptHook", () => {
  test("appends system prompt and artifact state to output.system", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await writeFile(join(dir, "backend/migrations/001_initial.sql"), "CREATE TABLE rfps (id UUID PRIMARY KEY);")
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })
    await writeFile(join(dir, "frontend/src/domain/pages/Dashboard.tsx"), "export default function Dashboard() {}")

    const { hook } = createBeforePromptHook(dir)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: ["existing system prompt"] }

    await hook(input as any, output)

    expect(output.system.length).toBeGreaterThan(1)
    expect(output.system.some((s) => s.includes("DOstack workbench composer"))).toBe(true)
    expect(output.system.some((s) => s.includes("Current Project State"))).toBe(true)
    expect(output.system.some((s) => s.includes("001_initial.sql"))).toBe(true)
  })

  test("appends Workflow Registry section when client is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    const mockWorkflows = [
      { workflow_id: "wf-abc", name: "RFP Analyzer", current_version: 3, step_types: ["llm_task"] },
      { workflow_id: "wf-def", name: "Risk Analyzer", current_version: 2, step_types: ["llm_task"] },
    ]

    const mockClient = {
      external: {
        get: async (_path: string) => ({ workflows: mockWorkflows }),
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
      internal: {
        get: async (_path: string) => ({}),
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
    } as unknown as ApiClient

    const { hook } = createBeforePromptHook(dir, mockClient)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    await hook(input as any, output)

    const registrySection = output.system.find((s) => s.includes("Workflow Registry"))
    expect(registrySection).toBeDefined()
    expect(registrySection).toContain("RFP Analyzer (wf-abc) — v3, llm_task")
    expect(registrySection).toContain("Risk Analyzer (wf-def) — v2, llm_task")
  })

  test("skips Workflow Registry section when client is not provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    const { hook } = createBeforePromptHook(dir)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    await hook(input as any, output)

    expect(output.system.some((s) => s.includes("Workflow Registry"))).toBe(false)
  })

  test("skips Workflow Registry section silently when client throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    const mockClient = {
      external: {
        get: async (_path: string) => { throw new Error("network error") },
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
      internal: {
        get: async (_path: string) => ({}),
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
    } as unknown as ApiClient

    const { hook } = createBeforePromptHook(dir, mockClient)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    // Should not throw
    await expect(hook(input as any, output)).resolves.toBeUndefined()
    expect(output.system.some((s) => s.includes("Workflow Registry"))).toBe(false)
  })

  test("uses cached registry within TTL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    let callCount = 0
    const mockClient = {
      external: {
        get: async (_path: string) => {
          callCount++
          return { workflows: [{ workflow_id: "wf-xyz", name: "My Flow", current_version: 1, step_types: [] }] }
        },
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
      internal: {
        get: async (_path: string) => ({}),
        post: async (_path: string, _body?: unknown) => ({}),
        put: async (_path: string, _body?: unknown) => ({}),
        delete: async (_path: string) => ({}),
      },
    } as unknown as ApiClient

    const { hook } = createBeforePromptHook(dir, mockClient)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }

    await hook(input as any, { system: [] })
    await hook(input as any, { system: [] })

    // Second call should use cache — API should have been called only once
    expect(callCount).toBe(1)
  })

  test("injects verification checklist when verification is pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })

    const { hook, setVerificationPending } = createBeforePromptHook(dir)

    setVerificationPending(true)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    await hook(input as any, output)

    const checklist = output.system.find((s) => s.includes("Post-Build Verification Required"))
    expect(checklist).toBeDefined()
    expect(checklist).toContain("dostack_validate_wiring")
    expect(checklist).toContain("dostack_trigger_preview")
  })

  test("injects runtime errors section when deploy signal exists and errors found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    await mkdir(join(dir, ".dostack"), { recursive: true })
    await writeFile(join(dir, ".dostack/preview-ready"), "")

    const mockConfig = {
      api_url: "https://api.dostack.ai",
      api_key: "dsk_test_key_123",
      workbench_id: "wb-test-001",
      workbench_slug: "test-slug",
    }

    const mockFetchErrors = async (_config: typeof mockConfig, _args: { minutes?: number }) => {
      return JSON.stringify({
        slug: "test-slug",
        errors: [
          { timestamp: "2026-04-15T10:00:00Z", function: "api", message: "KeyError: file_type" },
        ],
        logGroups: ["/aws/lambda/dostack-wb-app-test-slug-api"],
        timeWindowMinutes: 15,
        truncated: false,
      })
    }

    const { hook } = createBeforePromptHook(dir, undefined, {
      config: mockConfig,
      fetchErrors: mockFetchErrors,
    })

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    await hook(input as any, output)

    expect(output.system.some((s) => s.includes("Recent Runtime Errors"))).toBe(true)
    expect(output.system.some((s) => s.includes("KeyError"))).toBe(true)
  })

  test("caches runtime errors for 30 seconds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    await mkdir(join(dir, ".dostack"), { recursive: true })
    await writeFile(join(dir, ".dostack/preview-ready"), "")

    const mockConfig = {
      api_url: "https://api.dostack.ai",
      api_key: "dsk_test_key_123",
      workbench_id: "wb-test-001",
      workbench_slug: "test-slug",
    }

    let fetchCount = 0
    const mockFetchErrors = async (_config: typeof mockConfig, _args: { minutes?: number }) => {
      fetchCount++
      return JSON.stringify({
        slug: "test-slug",
        errors: [
          { timestamp: "2026-04-15T10:00:00Z", function: "api", message: "KeyError: file_type" },
        ],
        logGroups: [],
        timeWindowMinutes: 15,
        truncated: false,
      })
    }

    const { hook } = createBeforePromptHook(dir, undefined, {
      config: mockConfig,
      fetchErrors: mockFetchErrors,
    })

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }

    await hook(input as any, { system: [] })
    await hook(input as any, { system: [] })

    expect(fetchCount).toBe(1)
  })

  test("does not query runtime errors when no deploy signal exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    const mockConfig = {
      api_url: "https://api.dostack.ai",
      api_key: "dsk_test_key_123",
      workbench_id: "wb-test-001",
      workbench_slug: "test-slug",
    }

    let fetchCount = 0
    const mockFetchErrors = async (_config: typeof mockConfig, _args: { minutes?: number }) => {
      fetchCount++
      return JSON.stringify({ slug: "test-slug", errors: [], logGroups: [], timeWindowMinutes: 15, truncated: false })
    }

    const { hook } = createBeforePromptHook(dir, undefined, {
      config: mockConfig,
      fetchErrors: mockFetchErrors,
    })

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }
    const output = { system: [] as string[] }

    await hook(input as any, output)

    expect(fetchCount).toBe(0)
  })

  test("injects verification checklist only once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))

    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })

    const { hook, setVerificationPending } = createBeforePromptHook(dir)

    setVerificationPending(true)

    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } }

    const output1 = { system: [] as string[] }
    await hook(input as any, output1)
    expect(output1.system.some((s) => s.includes("Post-Build Verification Required"))).toBe(true)

    const output2 = { system: [] as string[] }
    await hook(input as any, output2)
    expect(output2.system.some((s) => s.includes("Post-Build Verification Required"))).toBe(false)
  })

  test("verification can re-arm after cache invalidation (new build cycle)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dostack-hook-"))
    await mkdir(join(dir, "backend/migrations"), { recursive: true })
    await mkdir(join(dir, "frontend/src/domain/pages"), { recursive: true })

    const { hook, invalidate, setVerificationPending } = createBeforePromptHook(dir)
    const input = { model: { modelID: "gemini-2.5-pro", providerID: "google" } } as any

    // First cycle: inject verification
    setVerificationPending(true)
    const output1 = { system: [] as string[] }
    await hook(input, output1)
    expect(output1.system.some((s) => s.includes("Post-Build Verification Required"))).toBe(true)

    // Second call: no injection (already injected)
    setVerificationPending(true)
    const output2 = { system: [] as string[] }
    await hook(input, output2)
    expect(output2.system.some((s) => s.includes("Post-Build Verification Required"))).toBe(false)

    // Invalidate (simulates file write after verification)
    invalidate()

    // New cycle: verification should re-arm
    setVerificationPending(true)
    const output3 = { system: [] as string[] }
    await hook(input, output3)
    expect(output3.system.some((s) => s.includes("Post-Build Verification Required"))).toBe(true)
  })
})
