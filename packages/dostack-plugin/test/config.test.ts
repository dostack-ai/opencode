import { describe, expect, test } from "bun:test"
import { parseDostackConfig } from "../src/config"

const validConfig = {
  api_url: "https://api.dostack.ai",
  api_key: "dsk_test_key_123",
  workbench_id: "wb_abc123",
}

describe("parseDostackConfig", () => {
  test("accepts valid full config", () => {
    const full = {
      ...validConfig,
      template_version: "v1",
      internal_api_url: "https://internal.dostack.ai",
      internal_api_token: "tok_secret",
    }
    const result = parseDostackConfig(full)
    expect(result.api_url).toBe(full.api_url)
    expect(result.api_key).toBe(full.api_key)
    expect(result.workbench_id).toBe(full.workbench_id)
    expect(result.template_version).toBe("v1")
    expect(result.internal_api_url).toBe(full.internal_api_url)
    expect(result.internal_api_token).toBe(full.internal_api_token)
  })

  test("accepts minimal config (only required fields)", () => {
    const result = parseDostackConfig(validConfig)
    expect(result.api_url).toBe(validConfig.api_url)
    expect(result.api_key).toBe(validConfig.api_key)
    expect(result.workbench_id).toBe(validConfig.workbench_id)
    expect(result.template_version).toBeUndefined()
    expect(result.internal_api_url).toBeUndefined()
    expect(result.internal_api_token).toBeUndefined()
  })

  test("rejects missing api_url", () => {
    const { api_url: _, ...noUrl } = validConfig
    expect(() => parseDostackConfig(noUrl)).toThrow("dostack-plugin: invalid config")
  })

  test("rejects api_key without dsk_ prefix", () => {
    expect(() =>
      parseDostackConfig({ ...validConfig, api_key: "bad_key_without_prefix" }),
    ).toThrow("dostack-plugin: invalid config")
  })

  test("rejects empty workbench_id", () => {
    expect(() =>
      parseDostackConfig({ ...validConfig, workbench_id: "" }),
    ).toThrow("dostack-plugin: invalid config")
  })

  test("rejects invalid api_url (not a URL)", () => {
    expect(() =>
      parseDostackConfig({ ...validConfig, api_url: "not-a-url" }),
    ).toThrow("dostack-plugin: invalid config")
  })
})
