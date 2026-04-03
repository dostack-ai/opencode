import { describe, test, expect } from "bun:test"
import { createBeforePromptHook } from "../../src/hooks/before-prompt"
import { mkdtemp, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

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
})
