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
})
