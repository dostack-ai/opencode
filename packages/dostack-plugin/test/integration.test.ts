import { describe, test, expect } from "bun:test"

describe("plugin module shape", () => {
  test("exports default with id and server function", async () => {
    const mod = await import("../src/index")
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe("dostack")
    expect(typeof mod.default.server).toBe("function")
  })

  test("server function returns hooks when called with valid config", async () => {
    const mod = await import("../src/index")
    const { mkdtemp } = await import("fs/promises")
    const { join } = await import("path")
    const { tmpdir } = await import("os")

    const dir = await mkdtemp(join(tmpdir(), "dostack-integration-"))

    const hooks = await mod.default.server(
      {
        client: {} as any,
        project: {} as any,
        directory: dir,
        worktree: dir,
        serverUrl: new URL("http://localhost:3000"),
        $: {} as any,
      },
      {
        api_url: "https://api.example.com/prod",
        api_key: "dsk_testkey1234567890abcdefghij1234567890abc",
        workbench_id: "test-bench",
      },
    )

    // Verify all 7 tools are registered
    expect(hooks.tool).toBeDefined()
    expect(hooks.tool!.dostack_query_workflows).toBeDefined()
    expect(hooks.tool!.dostack_get_workflow_schema).toBeDefined()
    expect(hooks.tool!.dostack_create_workflow_version).toBeDefined()
    expect(hooks.tool!.dostack_validate_wiring).toBeDefined()
    expect(hooks.tool!.dostack_flag_workflow_gap).toBeDefined()
    expect(hooks.tool!.dostack_trigger_preview).toBeDefined()
    expect(hooks.tool!.dostack_get_runtime_errors).toBeDefined()

    // Verify hooks
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
    expect(typeof hooks["tool.execute.after"]).toBe("function")
  })

  test("server function throws on invalid config", async () => {
    const mod = await import("../src/index")

    try {
      await mod.default.server(
        { client: {} as any, project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://localhost:3000"), $: {} as any },
        { api_url: "not-a-url" },
      )
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toContain("dostack-plugin: invalid config")
    }
  })
})
