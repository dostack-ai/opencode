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

  test("accepts missing api_url (phase1c mode doesn't need it)", () => {
    const { api_url: _, ...noUrl } = validConfig
    const result = parseDostackConfig(noUrl)
    expect(result.api_url).toBeUndefined()
    expect(result.workbench_id).toBe(validConfig.workbench_id)
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

  test("accepts phase1c-only config (no legacy api_url/api_key)", () => {
    const phase1cConfig = {
      workbench_id: "wb_abc123",
      workbench_slug: "rfp-app",
      coordinator_api_url: "https://composer.dev.dostack.ai",
      builder_auth_token: "builder-tok-xyz",
      build_job_id: "job_123",
      package_s3_bucket: "dostack-app-packages-dev",
    }
    const result = parseDostackConfig(phase1cConfig)
    expect(result.workbench_id).toBe("wb_abc123")
    expect(result.coordinator_api_url).toBe("https://composer.dev.dostack.ai")
    expect(result.builder_auth_token).toBe("builder-tok-xyz")
    expect(result.build_job_id).toBe("job_123")
    expect(result.package_s3_bucket).toBe("dostack-app-packages-dev")
    expect(result.api_url).toBeUndefined()
    expect(result.api_key).toBeUndefined()
  })

  test("accepts empty-string api_url and api_key (rendered from unset env vars)", () => {
    const phase1cEmptyLegacy = {
      api_url: "",
      api_key: "",
      workbench_id: "wb_abc123",
      coordinator_api_url: "https://composer.dev.dostack.ai",
      builder_auth_token: "builder-tok-xyz",
      build_job_id: "job_123",
      package_s3_bucket: "dostack-app-packages-dev",
    }
    const result = parseDostackConfig(phase1cEmptyLegacy)
    expect(result.workbench_id).toBe("wb_abc123")
  })
})
